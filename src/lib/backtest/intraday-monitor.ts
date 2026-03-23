/**
 * BSM-Based 4H Exit Monitor for WFA v3
 *
 * The core differentiator vs v2: evaluates credit spread trades with 4H
 * monitoring resolution using BSM repricing (no intraday option chains exist).
 *
 * Flow:
 * 1. Entry: real daily chain (same as v2) — findSpreadStrikes + applyFill
 * 2. 4H monitoring: BSM-reprice both legs at each 4H bar close
 * 3. Daily calibration: snap to real chain mid on last bar of each day
 */

import type { IntradayCandle } from './intraday-cache';
import type { OptionTrade, EntrySignal, SimConfig } from './option-sim';
import type { DynamicSlippageConfig } from './types';
import { bsmPrice, bsmDelta, ouIVEvolution } from './bsm-pricing';
import { applySpreadFill } from './slippage';

// ── Types ────────────────────────────────────────────────

export interface ChainAccessFns {
  /** Get full chain for a ticker on a date */
  getChain: (ticker: string, date: string) => any[];
  /** Find spread strikes (short delta, width, type, DTE range) */
  findSpread: (chain: any[], shortDelta: number, width: number, type: string, dteRange: [number, number]) => SpreadResult | null;
  /** Find a specific contract by strike/expiry/type (for daily calibration) */
  findContract: (ticker: string, date: string, strike: number, expiry: string, type: string) => ContractMatch | null;
  /** Apply fill model to a price */
  applyFillFn: (mid: number, bid: number, ask: number, side: 'buy' | 'sell', cfg: DynamicSlippageConfig, oi: number, dte: number) => { fillPrice: number; slippage: number };
}

export interface SpreadResult {
  short: ContractMatch;
  long: ContractMatch;
  netCredit: number;
  requestedSpreadWidth?: number;
  spreadWidth: number;
  maxLoss: number;
}

export interface ContractMatch {
  row: { strike: number; expir_date: string; dte: number; stock_price: number };
  type: string;
  bid: number;
  ask: number;
  mid: number;
  iv: number;
  delta: number;
  oi: number;
}

// ── BSM Spread Repricing ─────────────────────────────────

/**
 * BSM-reprice a credit spread at a given point in time.
 *
 * @param shortStrike   Short leg strike
 * @param longStrike    Long leg strike
 * @param stockPrice    Current stock price (from 4H candle close)
 * @param entryIV       IV at entry (annualized decimal)
 * @param hvTheta       Long-run mean IV for O-U evolution (HV60 or entry IV)
 * @param kappa         O-U mean reversion speed (annualized, default 4.0)
 * @param entryDTE      DTE at entry
 * @param daysElapsed   Calendar days elapsed since entry (fractional for 4H)
 * @param isCall        true for call spread, false for put spread
 * @param r             Risk-free rate (decimal)
 * @returns             Spread cost (short_value - long_value) and short delta
 */
export function bsmRepriceSpread(
  shortStrike: number,
  longStrike: number,
  stockPrice: number,
  entryIV: number,
  hvTheta: number,
  kappa: number,
  entryDTE: number,
  daysElapsed: number,
  isCall: boolean,
  r: number,
): { spreadCost: number; shortDelta: number } {
  // Evolve IV using Ornstein-Uhlenbeck mean reversion
  const evolvedIV = ouIVEvolution(entryIV, hvTheta, kappa, daysElapsed);
  const dteRemaining = Math.max(0, entryDTE - daysElapsed);
  const T = dteRemaining / 365;

  // BSM-price both legs
  const shortValue = bsmPrice(stockPrice, shortStrike, T, evolvedIV, r, isCall);
  const longValue = bsmPrice(stockPrice, longStrike, T, evolvedIV, r, isCall);
  const shortDelta = bsmDelta(stockPrice, shortStrike, T, evolvedIV, r, isCall);

  // Spread cost = what it costs to close the position = short - long
  const spreadCost = shortValue - longValue;

  return { spreadCost, shortDelta };
}

// ── 4H Monitor Core ──────────────────────────────────────

/**
 * Evaluate a credit spread trade using 4H monitoring resolution.
 *
 * Uses real chain for entry, BSM repricing for intraday monitoring,
 * and optional daily calibration to real chain mid prices.
 */
export function evaluateCreditSpread4H(
  signal: EntrySignal,
  config: SimConfig,
  monitorCandles: IntradayCandle[],
  _allTradingDates: string[],
  maxDate: string,
  chainAccess: ChainAccessFns,
): OptionTrade | null {
  // IV rank filter
  if (config.minIVRank > 0 && (signal.ivRank == null || signal.ivRank < config.minIVRank)) return null;

  // v2 volatility filters
  if ((config as any).vrpFilter && (config as any).vrpFilter > 0 &&
      ((signal as any).vrp == null || (signal as any).vrp < (config as any).vrpFilter)) return null;
  if ((config as any).contangoFilter && (config as any).contangoFilter > 0 &&
      ((signal as any).contango == null || (signal as any).contango < (config as any).contangoFilter)) return null;
  if ((config as any).slopeFilter && (config as any).slopeFilter > 0 &&
      ((signal as any).slope == null || (signal as any).slope < (config as any).slopeFilter)) return null;

  // Entry: use real daily chain
  const entryChain = chainAccess.getChain(signal.ticker, signal.date);
  if (entryChain.length === 0) return null;

  const optionType = signal.direction === 'CALL' ? 'Put' : 'Call';
  const spread = chainAccess.findSpread(
    entryChain, config.creditShortDelta, config.creditSpreadWidth,
    optionType, config.creditDTERange,
  );
  if (!spread || spread.netCredit <= 0) return null;

  let entryCredit = spread.netCredit;
  let entrySlippage = 0;
  if (config.fillMode === 'bidask' && config.slippage.enabled) {
    if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
      const spreadFill = applySpreadFill(
        'bidask',
        { ...spread.short, dte: spread.short.row.dte },
        { ...spread.long, dte: spread.long.row.dte },
        'open',
        config.slippage,
      );
      entryCredit = spreadFill.fillPrice;
      entrySlippage = spreadFill.slippage;
    } else {
      const shortFill = chainAccess.applyFillFn(
        spread.short.mid,
        spread.short.bid,
        spread.short.ask,
        'sell',
        config.slippage,
        spread.short.oi,
        spread.short.row.dte,
      );
      const longFill = chainAccess.applyFillFn(
        spread.long.mid,
        spread.long.bid,
        spread.long.ask,
        'buy',
        config.slippage,
        spread.long.oi,
        spread.long.row.dte,
      );
      entryCredit = shortFill.fillPrice - longFill.fillPrice;
      entrySlippage = shortFill.slippage + longFill.slippage;
    }
    if (entryCredit <= 0) return null;
  }
  const tpCost = entryCredit * (1 - config.creditProfitTarget);
  const slCost = entryCredit * config.creditStopLossMultiple;

  // Max loss stop threshold (in spread cost terms)
  const maxLoss = config.creditSpreadWidth - entryCredit;
  const maxLossStopCost = (config.creditMaxLossStopPct != null && config.creditMaxLossStopPct < 1.0)
    ? entryCredit + (config.creditMaxLossStopPct * maxLoss)
    : Infinity;

  // Trailing profit lock state
  let trailingFloorActive = false;
  let trailingFloorCost = Infinity;
  const tpProfit = entryCredit * config.creditProfitTarget;

  // Entry IV and HV theta for O-U evolution
  const entryIV = spread.short.iv > 0 ? spread.short.iv : 0.30; // fallback
  const thetaSource = config.ivThetaSource ?? 'hv60';
  const hvTheta = thetaSource === 'orats_iv60'
    ? (signal.oratsIV60 ?? signal.hv60 ?? entryIV)
    : thetaSource === 'hv60'
      ? (signal.hv60 ?? signal.oratsIV60 ?? entryIV)
      : entryIV;
  const kappa = config.bsmKappa ?? 4.0;
  const r = config.bsmRiskFreeRate ?? 0.04;
  const isCall = optionType === 'Call';
  const entryDTE = spread.short.row.dte;
  const entryTimestamp = new Date(signal.date + 'T00:00:00Z').getTime();

  // Filter monitor candles to the holding period
  const expiryDate = spread.short.row.expir_date;
  const monitorEnd = expiryDate < maxDate ? expiryDate : maxDate;
  const holdingCandles = monitorCandles.filter(c =>
    c.date > signal.date && c.date <= monitorEnd,
  );

  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
  let lastCalibratedDate = signal.date;

  for (const candle of holdingCandles) {
    // Compute fractional days elapsed
    // A 4H bar at 13:30 on day T+3 → daysElapsed ≈ 3 + (4/6.5) ≈ 3.62
    const barTimestamp = candle.timestamp;
    const calendarDaysElapsed = (barTimestamp - entryTimestamp) / (86400 * 1000);
    const daysElapsed = Math.max(0, calendarDaysElapsed);

    // BSM-reprice the spread
    const bsm = bsmRepriceSpread(
      spread.short.row.strike, spread.long.row.strike,
      candle.close, entryIV, hvTheta, kappa,
      entryDTE, daysElapsed, isCall, r,
    );

    let currentSpreadCost = bsm.spreadCost;
    let currentShortDelta = bsm.shortDelta;
    let exitSlippage = 0;

    // BSM can overshoot spread width for deep-ITM options — cap at defined-risk max
    const absSpreadWidth = Math.abs(spread.short.row.strike - spread.long.row.strike);
    currentSpreadCost = Math.min(currentSpreadCost, absSpreadWidth);

    // Daily calibration: on last bar of each day, try to snap to real chain
    const barDate = candle.date;
    if ((config.dailyCalibration ?? true) && barDate !== lastCalibratedDate) {
      const shortLeg = chainAccess.findContract(
        signal.ticker, barDate, spread.short.row.strike, expiryDate, optionType,
      );
      const longLeg = chainAccess.findContract(
        signal.ticker, barDate, spread.long.row.strike, expiryDate, optionType,
      );
      if (shortLeg && longLeg) {
        if (config.fillMode === 'bidask' && config.slippage.enabled) {
          if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
            const spreadFill = applySpreadFill(
              'bidask',
              { ...shortLeg, dte: shortLeg.row.dte },
              { ...longLeg, dte: longLeg.row.dte },
              'close',
              config.slippage,
            );
            currentSpreadCost = spreadFill.fillPrice;
            exitSlippage = spreadFill.slippage;
          } else {
            const shortClose = chainAccess.applyFillFn(
              shortLeg.mid,
              shortLeg.bid,
              shortLeg.ask,
              'buy',
              config.slippage,
              shortLeg.oi,
              shortLeg.row.dte,
            );
            const longClose = chainAccess.applyFillFn(
              longLeg.mid,
              longLeg.bid,
              longLeg.ask,
              'sell',
              config.slippage,
              longLeg.oi,
              longLeg.row.dte,
            );
            currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
            exitSlippage = shortClose.slippage + longClose.slippage;
          }
        } else {
          currentSpreadCost = shortLeg.mid - longLeg.mid;
        }
        currentShortDelta = shortLeg.delta;
        // Cap chain-derived cost at spread width max
        currentSpreadCost = Math.min(currentSpreadCost, absSpreadWidth);
      }
      lastCalibratedDate = barDate;
    }

    // Record mark-to-market
    dailyMtM.push({
      date: candle.datetime,
      spreadMid: currentSpreadCost,
      unrealizedPnl: (entryCredit - currentSpreadCost) * 100,
    });

    // Check DTE
    const currentDTE = entryDTE - daysElapsed;

    // Check exit conditions
    let exitType: string | null = null;

    // Update trailing lock state (must happen before exit checks)
    if (config.trailingActivatePct != null && config.trailingFloorPct != null) {
      const unrealizedProfit = entryCredit - currentSpreadCost;
      const activationProfit = config.trailingActivatePct * tpProfit;
      if (!trailingFloorActive && unrealizedProfit >= activationProfit) {
        trailingFloorActive = true;
        trailingFloorCost = entryCredit - (config.trailingFloorPct * tpProfit);
      }
    }

    if (currentSpreadCost <= tpCost) {
      exitType = 'PROFIT_TARGET';
    } else if (currentSpreadCost >= slCost) {
      exitType = 'STOP_LOSS';
    } else if (currentSpreadCost >= maxLossStopCost) {
      exitType = 'MAX_LOSS_STOP';
    } else if (config.creditDeltaStop && isFinite(config.creditDeltaStop) &&
               Math.abs(currentShortDelta) >= config.creditDeltaStop) {
      exitType = 'DELTA_STOP';
    } else if (trailingFloorActive && currentSpreadCost > trailingFloorCost) {
      exitType = 'TRAILING_LOCK';
    } else if (currentDTE <= (config.creditTimeStopDTE || 1)) {
      exitType = 'TIME_STOP';
    }

    if (exitType) {
      return buildTrade(
        signal, spread, entryCredit, barDate,
        currentSpreadCost, Math.max(0, Math.round(currentDTE)),
        candle.close, exitType, dailyMtM, entrySlippage, exitSlippage,
      );
    }
  }

  // Expiration: use last available data
  if (holdingCandles.length > 0) {
    const lastCandle = holdingCandles[holdingCandles.length - 1];
    const lastDate = lastCandle.date;
    const stockPrice = lastCandle.close;

    // Try real chain for expiration pricing
    const shortLeg = chainAccess.findContract(
      signal.ticker, lastDate, spread.short.row.strike, expiryDate, optionType,
    );
    const longLeg = chainAccess.findContract(
      signal.ticker, lastDate, spread.long.row.strike, expiryDate, optionType,
    );

    let cost: number;
    let exitSlippage = 0;
    if (shortLeg && longLeg) {
      if (config.fillMode === 'bidask' && config.slippage.enabled) {
        if ((config.slippage.executionStyle ?? 'combo') === 'combo') {
          const spreadFill = applySpreadFill(
            'bidask',
            { ...shortLeg, dte: shortLeg.row.dte },
            { ...longLeg, dte: longLeg.row.dte },
            'close',
            config.slippage,
          );
          cost = spreadFill.fillPrice;
          exitSlippage = spreadFill.slippage;
        } else {
          const shortClose = chainAccess.applyFillFn(
            shortLeg.mid,
            shortLeg.bid,
            shortLeg.ask,
            'buy',
            config.slippage,
            shortLeg.oi,
            shortLeg.row.dte,
          );
          const longClose = chainAccess.applyFillFn(
            longLeg.mid,
            longLeg.bid,
            longLeg.ask,
            'sell',
            config.slippage,
            longLeg.oi,
            longLeg.row.dte,
          );
          cost = shortClose.fillPrice - longClose.fillPrice;
          exitSlippage = shortClose.slippage + longClose.slippage;
        }
      } else {
        cost = shortLeg.mid - longLeg.mid;
      }
    } else {
      // Intrinsic value at expiration
      const si = isCall
        ? Math.max(0, stockPrice - spread.short.row.strike)
        : Math.max(0, spread.short.row.strike - stockPrice);
      const li = isCall
        ? Math.max(0, stockPrice - spread.long.row.strike)
        : Math.max(0, spread.long.row.strike - stockPrice);
      cost = si - li;
    }

    return buildTrade(
      signal, spread, entryCredit, lastDate, cost, 0,
      stockPrice, 'EXPIRATION', dailyMtM, entrySlippage, exitSlippage,
    );
  }

  return null;
}

// ── Trade Builder ────────────────────────────────────────

function buildTrade(
  signal: EntrySignal,
  spread: SpreadResult,
  entryCredit: number,
  exitDate: string,
  exitSpreadCost: number,
  exitDTE: number,
  exitStockPrice: number,
  exitType: string,
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[],
  entrySlippage?: number,
  exitSlippage?: number,
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
    requestedSpreadWidth: spread.requestedSpreadWidth,
    spreadWidth: spread.spreadWidth,
    maxProfit: entryCredit,
    maxLoss: spread.maxLoss,
    exitDate,
    exitPrice: exitSpreadCost,
    exitDTE,
    exitStockPrice,
    exitType: exitType as any,
    pnl,
    pnlPct,
    holdDays,
    ivRank: signal.ivRank,
    entrySlippage,
    exitSlippage,
    fillMode: configFillMode(entrySlippage, exitSlippage),
    dailyMtM,
  };
}

function configFillMode(entrySlippage?: number, exitSlippage?: number): 'mid' | 'bidask' | undefined {
  if ((entrySlippage ?? 0) > 0 || (exitSlippage ?? 0) > 0) return 'bidask';
  return undefined;
}
