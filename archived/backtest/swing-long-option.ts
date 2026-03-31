import {
  findContractDirect,
  findLongOptionInBand,
  type StrikeMatch,
  type LongOptionSelection,
} from './chain-cache';
import type { RepricingMethod } from './synthetic-reprice';
import { syntheticRepriceLeg } from './synthetic-reprice';
import { applyFill } from './slippage';
import { shouldExitUnderlyingTrend, type IndexedUnderlyingHistory } from './underlying-stop';
import type {
  EntrySignal,
  OptionDailyDiagnostic,
  OptionExitType,
  OptionTrade,
  SimConfig,
} from './option-sim';
import type { FillMode } from './types';

export type SwingLongSkipReason =
  | 'IV_RANK'
  | 'RECENT_GAP'
  | 'IV_ANOMALY'
  | 'CHAIN_MISSING'
  | 'NO_CONTRACT'
  | 'LOW_PREMIUM'
  | 'LOW_OI'
  | 'WIDE_SPREAD'
  | 'NO_BUDGET';

export interface SwingLongEvaluation {
  trade: OptionTrade | null;
  skipReason?: SwingLongSkipReason;
  entrySpreadPct?: number;
  entryOI?: number;
  contracts?: number;
  dailyMarks?: number;
  syntheticDays?: number;
}

export interface ShadowUnderlyingTrade {
  ticker: string;
  direction: 'CALL' | 'PUT';
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  holdDays: number;
  dteBand: string;
  dailyMtM: { date: string; close: number; unrealizedPnl: number }[];
}

function daysBetween(dateA: string, dateB: string): number {
  return Math.round((new Date(dateB).getTime() - new Date(dateA).getTime()) / 86400000);
}

function advanceTradingDays(allDates: string[], fromDate: string, n: number): string | null {
  const idx = allDates.indexOf(fromDate);
  if (idx < 0) {
    const nextIdx = allDates.findIndex(date => date > fromDate);
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

export function resolveSwingLongMinExitDTE(
  dteRange: [number, number],
  explicitValue?: number,
): number {
  if (explicitValue != null && Number.isFinite(explicitValue)) return explicitValue;
  return dteRange[1] <= 50 ? 14 : 21;
}

export function computeSwingLongContracts(
  startingCapital: number,
  riskBudgetPct: number,
  entryPrice: number,
): number {
  if (!Number.isFinite(startingCapital) || !Number.isFinite(riskBudgetPct) || !Number.isFinite(entryPrice)) return 0;
  if (startingCapital <= 0 || riskBudgetPct <= 0 || entryPrice <= 0) return 0;
  return Math.floor((startingCapital * riskBudgetPct) / (entryPrice * 100));
}

export function formatSwingLongBand(range?: [number, number]): string {
  return range ? `${range[0]}_${range[1]}` : 'na';
}

function repricingKind(method: RepricingMethod): 'exact' | 'synthetic' {
  return method === 'exact' ? 'exact' : 'synthetic';
}

function buildTrade(
  signal: EntrySignal,
  entry: LongOptionSelection,
  contracts: number,
  entryPrice: number,
  exitDate: string,
  exitPrice: number,
  exitDTE: number,
  exitStockPrice: number,
  exitType: OptionExitType,
  dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[],
  dailyDiagnostics: OptionDailyDiagnostic[],
  fillMode: FillMode,
  grossEntryPrice: number,
  grossExitPrice: number,
  entrySlippage: number,
  exitSlippage: number,
  entryCommission: number,
  exitCommission: number,
  repricingMethod?: RepricingMethod,
  syntheticDays?: number,
): OptionTrade {
  const grossPnl = (grossExitPrice - grossEntryPrice) * 100 * contracts;
  const pnl = (exitPrice - entryPrice) * 100 * contracts - entryCommission - exitCommission;
  const deployedCapital = entryPrice * 100 * contracts;
  const holdDays = daysBetween(signal.date, exitDate);

  return {
    ticker: signal.ticker,
    mode: 'SWING_LONG_OPTION',
    direction: signal.direction,
    entryDate: signal.date,
    entrySignalScore: signal.score,
    strike: entry.contract.row.strike,
    expiry: entry.contract.row.expir_date,
    entryDTE: entry.contract.row.dte,
    entryPrice,
    entryDelta: entry.contract.delta,
    entryIV: entry.contract.iv,
    entryStockPrice: entry.contract.row.stock_price,
    entryBidAskPct: entry.spreadPct,
    entryOI: entry.contract.oi,
    exitDate,
    exitPrice,
    exitDTE,
    exitStockPrice,
    exitType,
    pnl,
    grossPnl,
    pnlPct: deployedCapital > 0 ? pnl / deployedCapital : 0,
    holdDays,
    ivRank: signal.ivRank,
    entrySlippage,
    exitSlippage,
    entryCommission,
    exitCommission,
    fillMode,
    repricingMethod,
    syntheticDays,
    dailyMtM,
    dailyDiagnostics,
    positionSize: contracts,
    contracts,
  };
}

export function buildShadowUnderlyingTrade(trade: OptionTrade): ShadowUnderlyingTrade {
  const contracts = Math.max(0, trade.contracts ?? trade.positionSize ?? 1);
  const shares = contracts * 100 * Math.abs(trade.entryDelta ?? 0);
  const dailyMtM = (trade.dailyDiagnostics ?? []).map(point => ({
    date: point.date,
    close: point.underlyingPrice,
    unrealizedPnl: trade.direction === 'CALL'
      ? (point.underlyingPrice - trade.entryStockPrice) * shares
      : (trade.entryStockPrice - point.underlyingPrice) * shares,
  }));
  const pnl = trade.direction === 'CALL'
    ? (trade.exitStockPrice - trade.entryStockPrice) * shares
    : (trade.entryStockPrice - trade.exitStockPrice) * shares;
  return {
    ticker: trade.ticker,
    direction: trade.direction,
    entryDate: trade.entryDate,
    exitDate: trade.exitDate,
    entryPrice: trade.entryStockPrice,
    exitPrice: trade.exitStockPrice,
    shares,
    pnl,
    holdDays: trade.holdDays,
    dteBand: formatSwingLongBand(trade.entryDTE <= 50 ? [35, 50] : [50, 70]),
    dailyMtM,
  };
}

export function simulateSwingLongOption(
  signal: EntrySignal,
  config: SimConfig,
  allTradingDates: string[],
  maxDate: string,
  getEntryChain: (ticker: string, date: string) => ReturnType<typeof import('./chain-cache').getCachedChain>,
  indexedHistories: Record<string, IndexedUnderlyingHistory>,
  startingCapital: number,
  findContractAtDate: (
    ticker: string,
    date: string,
    strike: number,
    expiry: string,
    type: 'Call' | 'Put',
  ) => StrikeMatch | null = findContractDirect,
): SwingLongEvaluation {
  if (config.swingLongMaxIVRank != null && signal.ivRank != null && signal.ivRank > config.swingLongMaxIVRank) {
    return { trade: null, skipReason: 'IV_RANK' };
  }
  const recentGapPct = signal.recentMaxGapPct10 ?? signal.recentMaxGapPct;
  if (
    config.swingLongMaxRecentGapPct != null &&
    recentGapPct != null &&
    recentGapPct > config.swingLongMaxRecentGapPct
  ) {
    return { trade: null, skipReason: 'RECENT_GAP' };
  }
  if (
    config.swingLongMaxFrontBackIVAnomaly != null &&
    signal.frontBackIVAnomaly != null &&
    signal.frontBackIVAnomaly > config.swingLongMaxFrontBackIVAnomaly
  ) {
    return { trade: null, skipReason: 'IV_ANOMALY' };
  }

  const entryChain = getEntryChain(signal.ticker, signal.date);
  if (entryChain.length === 0) return { trade: null, skipReason: 'CHAIN_MISSING' };

  const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Call' : 'Put';
  const selection = findLongOptionInBand(
    entryChain,
    config.swingLongDeltaRange ?? [0.70, 0.80],
    optionType,
    config.swingLongDTERange ?? [35, 50],
    {
      minMid: 1,
      minOI: config.swingLongMinOI ?? 100,
      maxSpreadPct: config.swingLongMaxBidAskSpreadPct ?? 0.06,
    },
  );
  if (!selection) {
    const rawSelection = findLongOptionInBand(
      entryChain,
      config.swingLongDeltaRange ?? [0.70, 0.80],
      optionType,
      config.swingLongDTERange ?? [35, 50],
      {
        minMid: 0,
        minOI: 0,
        maxSpreadPct: Number.POSITIVE_INFINITY,
      },
    );
    if (!rawSelection) return { trade: null, skipReason: 'NO_CONTRACT' };
    if (rawSelection.contract.mid < 1) return { trade: null, skipReason: 'LOW_PREMIUM' };
    if (rawSelection.contract.oi < (config.swingLongMinOI ?? 100)) return { trade: null, skipReason: 'LOW_OI' };
    if (rawSelection.spreadPct > (config.swingLongMaxBidAskSpreadPct ?? 0.06)) return { trade: null, skipReason: 'WIDE_SPREAD' };
    return { trade: null, skipReason: 'NO_CONTRACT' };
  }

  const entryFill = applyFill(
    config.fillMode,
    selection.contract.mid,
    selection.contract.bid,
    selection.contract.ask,
    'buy',
    config.slippage,
    selection.contract.oi,
    selection.contract.row.dte,
  );
  const entryPrice = entryFill.fillPrice;
  const contracts = computeSwingLongContracts(
    startingCapital,
    config.swingLongRiskBudgetPct ?? 0.005,
    entryPrice,
  );
  if (contracts < 1) {
    return {
      trade: null,
      skipReason: 'NO_BUDGET',
      entrySpreadPct: selection.spreadPct,
      entryOI: selection.contract.oi,
    };
  }

  const grossEntryPrice = selection.contract.mid;
  const profitTargetPrice = entryPrice * (1 + (config.swingLongProfitTargetPct ?? 0.25));
  const minExitDTE = resolveSwingLongMinExitDTE(
    config.swingLongDTERange ?? [35, 50],
    config.swingLongMinExitDTE,
  );
  const monitorEnd = selection.contract.row.expir_date < maxDate ? selection.contract.row.expir_date : maxDate;
  const monitorDates = getMonitoringDates(
    allTradingDates,
    signal.date,
    config.monitoringIntervalDays,
    monitorEnd,
  );
  const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];
  const dailyDiagnostics: OptionDailyDiagnostic[] = [];

  const entryCommission = (config.commissionPerLeg ?? 0) * contracts;
  const exitCommission = (config.commissionPerLeg ?? 0) * contracts;
  let lastKnownStockPrice = selection.contract.row.stock_price;
  let lastValidIV: number | null = selection.contract.iv > 0 ? selection.contract.iv : null;
  let lastRepricingMethod: RepricingMethod = 'exact';
  let syntheticDays = 0;
  const ivTheta = signal.oratsIV60 ?? signal.hv60 ?? selection.contract.iv;
  const bsmR = config.bsmRiskFreeRate ?? 0.04;
  const bsmKappa = config.bsmKappa ?? 4.0;

  for (let index = 0; index < monitorDates.length; index += 1) {
    const checkDate = monitorDates[index];
    let current = findContractAtDate(
      signal.ticker,
      checkDate,
      selection.contract.row.strike,
      selection.contract.row.expir_date,
      optionType,
    );
    let dayMethod: RepricingMethod = 'exact';
    const monitoringStockPrice = current?.row.stock_price ?? lastKnownStockPrice;
    if (!current) {
      const synthetic = syntheticRepriceLeg({
        ticker: signal.ticker,
        date: checkDate,
        strike: selection.contract.row.strike,
        expiry: selection.contract.row.expir_date,
        type: optionType,
        entryIV: selection.contract.iv,
        entryDate: signal.date,
        lastValidIV,
        ivTheta,
        kappa: bsmKappa,
        r: bsmR,
      }, monitoringStockPrice);
      if (synthetic) {
        current = synthetic;
        dayMethod = synthetic.repricingMethod;
      }
    }
    if (!current) continue;
    if (current.row.stock_price > 0) lastKnownStockPrice = current.row.stock_price;
    if (current.iv > 0) lastValidIV = current.iv;
    if (dayMethod !== 'exact') {
      syntheticDays += 1;
      lastRepricingMethod = dayMethod;
    }

    const exitFill = applyFill(
      config.fillMode,
      current.mid,
      current.bid,
      current.ask,
      'sell',
      config.slippage,
      current.oi,
      current.row.dte,
    );
    const exitMark = exitFill.fillPrice;
    dailyMtM.push({
      date: checkDate,
      spreadMid: exitMark,
      unrealizedPnl: (exitMark - entryPrice) * 100 * contracts,
    });
    dailyDiagnostics.push({
      date: checkDate,
      underlyingPrice: current.row.stock_price,
      optionMid: current.mid,
      delta: current.delta,
      iv: current.iv,
      dte: current.row.dte,
      repricingMethod: repricingKind(dayMethod),
    });

    const heldTradingDays = index + 1;
    let exitType: OptionExitType | null = null;
    if (exitMark >= profitTargetPrice) {
      exitType = 'PROFIT_TARGET';
    } else if (shouldExitUnderlyingTrend(
      signal.ticker,
      checkDate,
      signal.direction,
      {
        underlyingExitEMA: config.underlyingExitEMA,
        underlyingExitConfirmDays: config.underlyingExitConfirmDays,
        underlyingExitRequireSlope: config.underlyingExitRequireSlope,
      },
      indexedHistories,
    )) {
      exitType = 'UNDERLYING_EXIT';
    } else if (
      heldTradingDays >= (config.swingLongMaxHoldDays ?? 10) ||
      current.row.dte <= minExitDTE
    ) {
      exitType = 'TIME_STOP';
    }

    if (exitType) {
      return {
        trade: buildTrade(
          signal,
          selection,
          contracts,
          entryPrice,
          checkDate,
          exitMark,
          current.row.dte,
          current.row.stock_price,
          exitType,
          dailyMtM,
          dailyDiagnostics,
          config.fillMode,
          grossEntryPrice,
          current.mid,
          entryFill.slippage,
          exitFill.slippage,
          entryCommission,
          exitCommission,
          syntheticDays > 0 ? lastRepricingMethod : undefined,
          syntheticDays > 0 ? syntheticDays : undefined,
        ),
        entrySpreadPct: selection.spreadPct,
        entryOI: selection.contract.oi,
        contracts,
        dailyMarks: dailyDiagnostics.length,
        syntheticDays,
      };
    }
  }

  const lastDate = monitorDates[monitorDates.length - 1] ?? monitorEnd;
  if (!lastDate) {
    return { trade: null, skipReason: 'CHAIN_MISSING' };
  }

  let current = findContractDirect(
    signal.ticker,
    lastDate,
    selection.contract.row.strike,
    selection.contract.row.expir_date,
    optionType,
  );
  current = current ?? findContractAtDate(
    signal.ticker,
    lastDate,
    selection.contract.row.strike,
    selection.contract.row.expir_date,
    optionType,
  );
  let grossExitPrice: number;
  let exitPrice: number;
  let exitDTE: number;
  let exitStockPrice: number;
  let exitSlippage = 0;
  if (current) {
    const exitFill = applyFill(
      config.fillMode,
      current.mid,
      current.bid,
      current.ask,
      'sell',
      config.slippage,
      current.oi,
      current.row.dte,
    );
    grossExitPrice = current.mid;
    exitPrice = exitFill.fillPrice;
    exitDTE = current.row.dte;
    exitStockPrice = current.row.stock_price;
    exitSlippage = exitFill.slippage;
    dailyDiagnostics.push({
      date: lastDate,
      underlyingPrice: current.row.stock_price,
      optionMid: current.mid,
      delta: current.delta,
      iv: current.iv,
      dte: current.row.dte,
      repricingMethod: 'exact',
    });
  } else {
    const synthetic = syntheticRepriceLeg({
      ticker: signal.ticker,
      date: lastDate,
      strike: selection.contract.row.strike,
      expiry: selection.contract.row.expir_date,
      type: optionType,
      entryIV: selection.contract.iv,
      entryDate: signal.date,
      lastValidIV,
      ivTheta,
      kappa: bsmKappa,
      r: bsmR,
    }, lastKnownStockPrice);
    if (synthetic) {
      current = synthetic;
      syntheticDays += 1;
      lastRepricingMethod = synthetic.repricingMethod;
      grossExitPrice = synthetic.mid;
      const exitFill = applyFill(
        config.fillMode,
        synthetic.mid,
        synthetic.bid,
        synthetic.ask,
        'sell',
        config.slippage,
        synthetic.oi,
        synthetic.row.dte,
      );
      exitPrice = exitFill.fillPrice;
      exitDTE = synthetic.row.dte;
      exitStockPrice = synthetic.row.stock_price;
      exitSlippage = exitFill.slippage;
      dailyDiagnostics.push({
        date: lastDate,
        underlyingPrice: synthetic.row.stock_price,
        optionMid: synthetic.mid,
        delta: synthetic.delta,
        iv: synthetic.iv,
        dte: synthetic.row.dte,
        repricingMethod: 'synthetic',
      });
    } else {
      const intrinsicValue = optionType === 'Call'
        ? Math.max(0, lastKnownStockPrice - selection.contract.row.strike)
        : Math.max(0, selection.contract.row.strike - lastKnownStockPrice);
      grossExitPrice = intrinsicValue;
      exitPrice = intrinsicValue;
      exitDTE = 0;
      exitStockPrice = lastKnownStockPrice;
      dailyDiagnostics.push({
        date: lastDate,
        underlyingPrice: lastKnownStockPrice,
        optionMid: intrinsicValue,
        delta: null,
        iv: null,
        dte: 0,
        repricingMethod: 'synthetic',
      });
    }
  }

  if (!dailyMtM.some(point => point.date === lastDate)) {
    dailyMtM.push({
      date: lastDate,
      spreadMid: exitPrice,
      unrealizedPnl: (exitPrice - entryPrice) * 100 * contracts,
    });
  }

  return {
    trade: buildTrade(
      signal,
      selection,
      contracts,
      entryPrice,
      lastDate,
      exitPrice,
      exitDTE,
      exitStockPrice,
      'EXPIRATION',
      dailyMtM,
      dailyDiagnostics,
      config.fillMode,
      grossEntryPrice,
      grossExitPrice,
      entryFill.slippage,
      exitSlippage,
      entryCommission,
      exitCommission,
      syntheticDays > 0 ? lastRepricingMethod : undefined,
      syntheticDays > 0 ? syntheticDays : undefined,
    ),
    entrySpreadPct: selection.spreadPct,
    entryOI: selection.contract.oi,
    contracts,
    dailyMarks: dailyDiagnostics.length,
    syntheticDays,
  };
}
