import type { DynamicSlippageConfig, FillMode } from './types';
import type { EntrySignal, OptionExitType, OptionTrade, SimConfig } from './option-sim';
import type { ChainRow, SpreadMatch, StrikeMatch } from './chain-cache';
import {
  findContractDirect,
  getCachedChain,
  getCachedCores,
} from './chain-cache';
import {
  clampSpreadCloseCost,
  computeCreditSpreadThresholds,
  computeIntrinsicSpreadCloseCost,
  createMissingChainState,
  resolveActualSpreadWidth,
  resolveTriggeredCreditExitCost,
  shouldExitNoChain,
  updateMissingChainState,
} from './credit-spread-exit';
import { applyFill, applySpreadFill } from './slippage';
import { syntheticRepriceLeg, type RepricingMethod } from './synthetic-reprice';

export interface SlimCreditTrade {
  ticker: string;
  entryDate: string;
  exitDate: string;
  pnl: number;
  pnlPct: number;
  holdDays: number;
  exitType: OptionExitType;
  direction: 'CALL' | 'PUT';
  entryDelta: number;
  entryDTE: number;
  strike: number;
  spreadWidth: number;
}

export interface ReplaySignalOverrides {
  score?: number;
  ivRank?: number;
  hv60?: number;
  oratsIV60?: number;
}

function resolveOptionType(direction: SlimCreditTrade['direction']): 'Call' | 'Put' {
  return direction === 'CALL' ? 'Put' : 'Call';
}

function resolveLongStrike(trade: SlimCreditTrade): number {
  return trade.direction === 'CALL'
    ? trade.strike - trade.spreadWidth
    : trade.strike + trade.spreadWidth;
}

function buildStrikeMatch(row: ChainRow, type: 'Call' | 'Put'): StrikeMatch {
  const isCall = type === 'Call';
  return {
    row,
    type,
    bid: isCall ? row.call_bid : row.put_bid,
    ask: isCall ? row.call_ask : row.put_ask,
    mid: isCall ? row.call_mid : row.put_mid,
    iv: isCall ? row.call_iv : row.put_iv,
    delta: isCall ? row.delta : (row.delta - 1),
    volume: isCall ? row.call_volume : row.put_volume,
    oi: isCall ? row.call_oi : row.put_oi,
  };
}

function resolveEntrySpread(
  trade: SlimCreditTrade,
): { spread: SpreadMatch; optionType: 'Call' | 'Put' } | null {
  const optionType = resolveOptionType(trade.direction);
  const longStrike = resolveLongStrike(trade);
  const entryRows = getCachedChain(trade.ticker, trade.entryDate)
    .filter(row => row.dte === trade.entryDTE);

  const candidates = new Map<string, { short?: ChainRow; long?: ChainRow }>();
  for (const row of entryRows) {
    const match = candidates.get(row.expir_date) ?? {};
    if (Math.abs(row.strike - trade.strike) < 0.01) {
      match.short = row;
    } else if (Math.abs(row.strike - longStrike) < 0.01) {
      match.long = row;
    }
    candidates.set(row.expir_date, match);
  }

  const complete = [...candidates.entries()]
    .filter(([, legs]) => legs.short && legs.long)
    .map(([expiry, legs]) => ({ expiry, short: legs.short!, long: legs.long! }));
  if (complete.length !== 1) return null;

  const { short, long } = complete[0];
  const shortLeg = buildStrikeMatch(short, optionType);
  const longLeg = buildStrikeMatch(long, optionType);
  const netCredit = shortLeg.mid - longLeg.mid;
  const actualWidth = Math.abs(shortLeg.row.strike - longLeg.row.strike);
  if (!(netCredit > 0) || !(actualWidth > 0)) return null;

  return {
    optionType,
    spread: {
      short: shortLeg,
      long: longLeg,
      netCredit,
      requestedSpreadWidth: trade.spreadWidth,
      spreadWidth: actualWidth,
      maxLoss: actualWidth - netCredit,
    },
  };
}

function buildSignal(
  trade: SlimCreditTrade,
  overrides: ReplaySignalOverrides = {},
): EntrySignal {
  const cores = getCachedCores(trade.ticker, trade.entryDate);
  return {
    ticker: trade.ticker,
    date: trade.entryDate,
    direction: trade.direction,
    score: overrides.score ?? 100,
    ivRank: overrides.ivRank,
    hv60: overrides.hv60,
    oratsIV60: overrides.oratsIV60 ?? cores?.iv60,
  };
}

function advanceTradingDays(allDates: string[], fromDate: string, n: number): string | null {
  const idx = allDates.indexOf(fromDate);
  if (idx < 0) {
    const nextIdx = allDates.findIndex(d => d > fromDate);
    if (nextIdx < 0) return null;
    return allDates[Math.min(nextIdx + n - 1, allDates.length - 1)] ?? null;
  }
  const targetIdx = idx + n;
  return targetIdx < allDates.length ? allDates[targetIdx] : null;
}

function getMonitoringDates(
  allDates: string[],
  entryDate: string,
  intervalDays: number,
  maxDate: string,
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

function buildTradeResult(
  signal: EntrySignal,
  spread: SpreadMatch,
  entryCredit: number,
  exitDate: string,
  exitSpreadCost: number,
  exitDTE: number,
  exitStockPrice: number,
  exitType: OptionExitType,
  dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[],
  entrySlippage: number,
  exitSlippage: number,
  fillMode: FillMode,
): OptionTrade {
  const actualWidth = resolveActualSpreadWidth(spread);
  const boundedEntryCredit = clampSpreadCloseCost(entryCredit, actualWidth);
  const boundedExitCost = clampSpreadCloseCost(exitSpreadCost, actualWidth);
  const maxLoss = Math.max(0, actualWidth - boundedEntryCredit);
  const pnl = Math.max(
    -maxLoss * 100,
    Math.min((boundedEntryCredit - boundedExitCost) * 100, boundedEntryCredit * 100),
  );
  const pnlPct = maxLoss > 0 ? pnl / (maxLoss * 100) : 0;
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
    entryPrice: boundedEntryCredit,
    entryDelta: spread.short.delta,
    entryIV: spread.short.iv,
    entryStockPrice: spread.short.row.stock_price,
    longStrike: spread.long.row.strike,
    longEntryPrice: spread.long.mid,
    requestedSpreadWidth: spread.requestedSpreadWidth,
    spreadWidth: actualWidth,
    maxProfit: boundedEntryCredit,
    maxLoss,
    exitDate,
    exitPrice: boundedExitCost,
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
    positionSize: 1,
  };
}

function resolveExitSpreadCost(
  fillMode: FillMode,
  slippage: DynamicSlippageConfig,
  shortLeg: StrikeMatch,
  longLeg: StrikeMatch,
): { currentSpreadCost: number; exitSlippage: number } {
  let currentSpreadCost: number;
  let exitSlippage = 0;
  if (fillMode === 'bidask' && slippage.enabled) {
    if ((slippage.executionStyle ?? 'combo') === 'combo') {
      const spreadFill = applySpreadFill(
        'bidask',
        { ...shortLeg, dte: shortLeg.row.dte },
        { ...longLeg, dte: longLeg.row.dte },
        'close',
        slippage,
      );
      currentSpreadCost = spreadFill.fillPrice;
      exitSlippage = spreadFill.slippage;
    } else {
      const shortClose = applyFill(
        'bidask',
        shortLeg.mid,
        shortLeg.bid,
        shortLeg.ask,
        'buy',
        slippage,
        shortLeg.oi,
        shortLeg.row.dte,
      );
      const longClose = applyFill(
        'bidask',
        longLeg.mid,
        longLeg.bid,
        longLeg.ask,
        'sell',
        slippage,
        longLeg.oi,
        longLeg.row.dte,
      );
      currentSpreadCost = shortClose.fillPrice - longClose.fillPrice;
      exitSlippage = shortClose.slippage + longClose.slippage;
    }
  } else {
    currentSpreadCost = shortLeg.mid - longLeg.mid;
  }
  return { currentSpreadCost, exitSlippage };
}

export function replaySlimCreditTrade(
  trade: SlimCreditTrade,
  config: SimConfig,
  allTradingDates: string[],
  maxDate: string,
  signalOverrides: ReplaySignalOverrides = {},
): OptionTrade | null {
  const resolved = resolveEntrySpread(trade);
  if (!resolved) return null;

  const signal = buildSignal(trade, signalOverrides);
  const { spread, optionType } = resolved;
  const fillMode = config.fillMode;

  let entryCredit: number;
  let entrySlippage = 0;
  if (fillMode === 'bidask' && config.slippage.enabled) {
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
      const shortFill = applyFill(
        'bidask',
        spread.short.mid,
        spread.short.bid,
        spread.short.ask,
        'sell',
        config.slippage,
        spread.short.oi,
        spread.short.row.dte,
      );
      const longFill = applyFill(
        'bidask',
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
    if (!(entryCredit > 0)) return null;
  } else {
    entryCredit = spread.netCredit;
  }

  const thresholds = computeCreditSpreadThresholds(config, spread, entryCredit);
  const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;
  const monitorDates = getMonitoringDates(allTradingDates, signal.date, config.monitoringIntervalDays, monitorEnd);
  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
  let missingChainState = createMissingChainState();
  let lastValidSpreadCost: number | null = null;
  let lastShortIV: number | null = spread.short.iv > 0 ? spread.short.iv : null;
  let lastLongIV: number | null = spread.long.iv > 0 ? spread.long.iv : null;
  let lastKnownStockPrice = spread.short.row.stock_price;
  let syntheticDayCount = 0;
  let lastRepricingMethod: RepricingMethod = 'exact';
  const bsmR = config.bsmRiskFreeRate ?? 0.04;
  const bsmKappa = config.bsmKappa ?? 4.0;
  const ivTheta = signal.oratsIV60 ?? signal.hv60 ?? spread.short.iv;

  for (const checkDate of monitorDates) {
    let shortLeg = findContractDirect(
      signal.ticker,
      checkDate,
      spread.short.row.strike,
      spread.short.row.expir_date,
      optionType,
    );
    let longLeg = findContractDirect(
      signal.ticker,
      checkDate,
      spread.long.row.strike,
      spread.long.row.expir_date,
      optionType,
    );
    const fallbackChain = (!shortLeg || !longLeg) ? getCachedChain(signal.ticker, checkDate) : [];
    const monitoringStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price;
    if (monitoringStockPrice != null && Number.isFinite(monitoringStockPrice)) {
      lastKnownStockPrice = monitoringStockPrice;
    }

    let dayUsedSynthetic = false;
    let dayRepricingMethod: RepricingMethod = 'exact';
    if (!shortLeg) {
      const synthShort = syntheticRepriceLeg({
        ticker: signal.ticker,
        date: checkDate,
        strike: spread.short.row.strike,
        expiry: spread.short.row.expir_date,
        type: optionType,
        entryIV: spread.short.iv,
        entryDate: signal.date,
        lastValidIV: lastShortIV,
        ivTheta,
        kappa: bsmKappa,
        r: bsmR,
      }, monitoringStockPrice ?? lastKnownStockPrice);
      if (synthShort) {
        shortLeg = synthShort;
        dayUsedSynthetic = true;
        dayRepricingMethod = synthShort.repricingMethod;
      }
    }
    if (!longLeg) {
      const synthLong = syntheticRepriceLeg({
        ticker: signal.ticker,
        date: checkDate,
        strike: spread.long.row.strike,
        expiry: spread.short.row.expir_date,
        type: optionType,
        entryIV: spread.long.iv,
        entryDate: signal.date,
        lastValidIV: lastLongIV,
        ivTheta,
        kappa: bsmKappa,
        r: bsmR,
      }, monitoringStockPrice ?? lastKnownStockPrice);
      if (synthLong) {
        longLeg = synthLong;
        dayUsedSynthetic = true;
        if (dayRepricingMethod === 'exact') dayRepricingMethod = synthLong.repricingMethod;
      }
    }

    const hasValidLegs = Boolean(shortLeg && longLeg);
    missingChainState = updateMissingChainState(missingChainState, hasValidLegs);
    if (!hasValidLegs) {
      if (shouldExitNoChain(config, missingChainState)) {
        const intrinsicCost = monitoringStockPrice != null && Number.isFinite(monitoringStockPrice)
          ? computeIntrinsicSpreadCloseCost(
              optionType,
              spread.short.row.strike,
              spread.long.row.strike,
              monitoringStockPrice,
              thresholds.actualWidth,
            )
          : null;
        const noChainMark = Math.max(
          lastValidSpreadCost ?? thresholds.boundedEntryCredit,
          intrinsicCost ?? thresholds.boundedEntryCredit,
        );
        const exitCost = resolveTriggeredCreditExitCost('NO_CHAIN', noChainMark, thresholds);
        const replayed = buildTradeResult(
          signal,
          spread,
          entryCredit,
          checkDate,
          exitCost,
          shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0,
          monitoringStockPrice ?? spread.short.row.stock_price,
          'NO_CHAIN',
          dailyMtM,
          entrySlippage,
          0,
          fillMode,
        );
        if (syntheticDayCount > 0) {
          replayed.repricingMethod = lastRepricingMethod;
          replayed.syntheticDays = syntheticDayCount;
        }
        return replayed;
      }
      continue;
    }
    if (dayUsedSynthetic) {
      syntheticDayCount++;
      lastRepricingMethod = dayRepricingMethod;
    }

    const resolvedShort = shortLeg!;
    const resolvedLong = longLeg!;
    const { currentSpreadCost: rawSpreadCost, exitSlippage } = resolveExitSpreadCost(
      fillMode,
      config.slippage,
      resolvedShort,
      resolvedLong,
    );
    const currentSpreadCost = clampSpreadCloseCost(rawSpreadCost, thresholds.actualWidth);
    const currentDTE = resolvedShort.row.dte;
    lastValidSpreadCost = currentSpreadCost;
    if (resolvedShort.iv > 0) lastShortIV = resolvedShort.iv;
    if (resolvedLong.iv > 0) lastLongIV = resolvedLong.iv;

    dailyMtM.push({
      date: checkDate,
      spreadMid: currentSpreadCost,
      unrealizedPnl: (entryCredit - currentSpreadCost) * 100,
    });

    let exitType: OptionExitType | null = null;
    if (currentSpreadCost <= thresholds.tpCost) exitType = 'PROFIT_TARGET';
    else if (currentSpreadCost >= thresholds.slCost) exitType = 'STOP_LOSS';
    else if (
      config.creditDeltaStop != null &&
      Number.isFinite(config.creditDeltaStop) &&
      Math.abs(resolvedShort.delta) >= config.creditDeltaStop
    ) exitType = 'DELTA_STOP';
    else if (currentDTE <= config.creditTimeStopDTE) exitType = 'TIME_STOP';

    if (exitType) {
      const exitCost = resolveTriggeredCreditExitCost(exitType, currentSpreadCost, thresholds);
      const replayed = buildTradeResult(
        signal,
        spread,
        entryCredit,
        checkDate,
        exitCost,
        currentDTE,
        resolvedShort.row.stock_price,
        exitType,
        dailyMtM,
        entrySlippage,
        exitSlippage,
        fillMode,
      );
      if (syntheticDayCount > 0) {
        replayed.repricingMethod = lastRepricingMethod;
        replayed.syntheticDays = syntheticDayCount;
      }
      return replayed;
    }
  }

  const lastDate = monitorDates[monitorDates.length - 1];
  if (!lastDate) return null;

  let shortLeg = findContractDirect(
    signal.ticker,
    lastDate,
    spread.short.row.strike,
    spread.short.row.expir_date,
    optionType,
  );
  let longLeg = findContractDirect(
    signal.ticker,
    lastDate,
    spread.long.row.strike,
    spread.long.row.expir_date,
    optionType,
  );
  const fallbackChain = (!shortLeg || !longLeg) ? getCachedChain(signal.ticker, lastDate) : [];
  const lastStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price ?? lastKnownStockPrice;

  if (!shortLeg) {
    const synthShort = syntheticRepriceLeg({
      ticker: signal.ticker,
      date: lastDate,
      strike: spread.short.row.strike,
      expiry: spread.short.row.expir_date,
      type: optionType,
      entryIV: spread.short.iv,
      entryDate: signal.date,
      lastValidIV: lastShortIV,
      ivTheta,
      kappa: bsmKappa,
      r: bsmR,
    }, lastStockPrice);
    if (synthShort) {
      shortLeg = synthShort;
      syntheticDayCount++;
      lastRepricingMethod = synthShort.repricingMethod;
    }
  }
  if (!longLeg) {
    const synthLong = syntheticRepriceLeg({
      ticker: signal.ticker,
      date: lastDate,
      strike: spread.long.row.strike,
      expiry: spread.short.row.expir_date,
      type: optionType,
      entryIV: spread.long.iv,
      entryDate: signal.date,
      lastValidIV: lastLongIV,
      ivTheta,
      kappa: bsmKappa,
      r: bsmR,
    }, lastStockPrice);
    if (synthLong) {
      longLeg = synthLong;
      syntheticDayCount++;
      lastRepricingMethod = synthLong.repricingMethod;
    }
  }

  let finalSpreadCost: number;
  let exitDTE: number;
  let exitStockPrice: number;
  if (shortLeg && longLeg) {
    finalSpreadCost = clampSpreadCloseCost(shortLeg.mid - longLeg.mid, thresholds.actualWidth);
    exitDTE = shortLeg.row.dte;
    exitStockPrice = shortLeg.row.stock_price;
  } else {
    const stockPrice = lastStockPrice ?? spread.short.row.stock_price;
    finalSpreadCost = computeIntrinsicSpreadCloseCost(
      optionType,
      spread.short.row.strike,
      spread.long.row.strike,
      stockPrice,
      thresholds.actualWidth,
    );
    exitDTE = shortLeg?.row.dte ?? longLeg?.row.dte ?? fallbackChain[0]?.dte ?? 0;
    exitStockPrice = stockPrice;
  }

  const replayed = buildTradeResult(
    signal,
    spread,
    entryCredit,
    lastDate,
    finalSpreadCost,
    exitDTE,
    exitStockPrice,
    'EXPIRATION',
    dailyMtM,
    entrySlippage,
    0,
    fillMode,
  );
  if (syntheticDayCount > 0) {
    replayed.repricingMethod = lastRepricingMethod;
    replayed.syntheticDays = syntheticDayCount;
  }
  return replayed;
}
