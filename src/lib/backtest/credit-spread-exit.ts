import type { EntrySignal, OptionExitType, OptionTrade, SimConfig } from './option-sim';

type SpreadLike = {
  spreadWidth?: number;
  short: { row: { strike: number } };
  long: { row: { strike: number } };
};

export interface CreditSpreadThresholds {
  actualWidth: number;
  boundedEntryCredit: number;
  maxLoss: number;
  tpCost: number;
  slCost: number;
  maxLossStopCost: number;
  tpProfit: number;
}

export interface MissingChainState {
  consecutiveMissingDays: number;
  totalMonitoringDays: number;
  missingMonitoringDays: number;
}

type CreditSpreadTradeSignalLike = Pick<EntrySignal, 'ticker' | 'date' | 'direction' | 'score' | 'ivRank'>;

type CreditSpreadTradeSpreadLike = SpreadLike & {
  requestedSpreadWidth?: number;
  short: {
    row: {
      strike: number;
      expir_date: string;
      dte: number;
      stock_price: number;
    };
    delta: number;
    iv: number;
    mid: number;
  };
  long: {
    row: {
      strike: number;
    };
    mid: number;
  };
};

export interface CreditSpreadTradeBuildParams {
  signal: CreditSpreadTradeSignalLike;
  spread: CreditSpreadTradeSpreadLike;
  entryCredit: number;
  grossEntryCredit?: number;
  exitDate: string;
  exitSpreadCost: number;
  grossExitSpreadCost?: number;
  exitDTE: number;
  exitStockPrice: number;
  exitType: OptionExitType;
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[];
  entrySlippage?: number;
  exitSlippage?: number;
  entryCommission?: number;
  exitCommission?: number;
  fillMode?: SimConfig['fillMode'];
  overrideGrossPnl?: number;
  overrideNetPnl?: number;
  overrideNetPnlPct?: number;
}

export const DEFAULT_MISSING_CHAIN_EXIT_AFTER_DAYS = 999;
export const CREDIT_SPREAD_LEG_COUNT = 2;

export function resolveActualSpreadWidth(spread: SpreadLike): number {
  const explicitWidth = spread.spreadWidth;
  if (explicitWidth != null && Number.isFinite(explicitWidth) && explicitWidth > 0) {
    return explicitWidth;
  }
  return Math.abs(spread.short.row.strike - spread.long.row.strike);
}

export function clampSpreadCloseCost(cost: number, actualWidth: number): number {
  if (!Number.isFinite(cost)) return Math.max(0, actualWidth);
  return Math.min(Math.max(0, cost), Math.max(0, actualWidth));
}

/**
 * Upper-cap a spread cost at its width without flooring negative values.
 *
 * Use this for theoretical/BSM mark-to-market where small negative values can
 * occur due to numerical artifacts and should not be flattened to 0 (which
 * distorts the MtM signal), while still enforcing the defined-risk upper bound.
 */
export function capSpreadCloseCostUpper(cost: number, actualWidth: number): number {
  if (!Number.isFinite(cost)) return Math.max(0, actualWidth);
  return Math.min(cost, Math.max(0, actualWidth));
}

export function computeCreditSpreadThresholds(
  originConfig: Pick<SimConfig, 'creditProfitTarget' | 'creditStopLossMultiple' | 'creditMaxLossStopPct'>,
  spread: SpreadLike,
  entryCredit: number,
): CreditSpreadThresholds {
  const actualWidth = resolveActualSpreadWidth(spread);
  const boundedEntryCredit = clampSpreadCloseCost(entryCredit, actualWidth);
  const maxLoss = Math.max(0, actualWidth - boundedEntryCredit);
  const tpProfit = Math.max(0, boundedEntryCredit * originConfig.creditProfitTarget);
  const tpCost = clampSpreadCloseCost(boundedEntryCredit - tpProfit, actualWidth);
  const slCost = clampSpreadCloseCost(
    boundedEntryCredit * originConfig.creditStopLossMultiple,
    actualWidth,
  );
  const maxLossStopCost =
    originConfig.creditMaxLossStopPct != null &&
    Number.isFinite(originConfig.creditMaxLossStopPct) &&
    originConfig.creditMaxLossStopPct < 1
      ? clampSpreadCloseCost(
          boundedEntryCredit + originConfig.creditMaxLossStopPct * maxLoss,
          actualWidth,
        )
      : Infinity;

  return {
    actualWidth,
    boundedEntryCredit,
    maxLoss,
    tpCost,
    slCost,
    maxLossStopCost,
    tpProfit,
  };
}

export function computeIntrinsicSpreadCloseCost(
  optionType: 'Call' | 'Put',
  shortStrike: number,
  longStrike: number,
  stockPrice: number,
  actualWidth: number,
): number {
  const shortIntrinsic = optionType === 'Put'
    ? Math.max(0, shortStrike - stockPrice)
    : Math.max(0, stockPrice - shortStrike);
  const longIntrinsic = optionType === 'Put'
    ? Math.max(0, longStrike - stockPrice)
    : Math.max(0, stockPrice - longStrike);

  return clampSpreadCloseCost(shortIntrinsic - longIntrinsic, actualWidth);
}

export function resolveTriggeredCreditExitCost(
  exitType: OptionExitType,
  currentSpreadCost: number,
  thresholds: CreditSpreadThresholds,
  opts: {
    trailingFloorCost?: number;
    overrideThresholdCost?: number;
  } = {},
): number {
  switch (exitType) {
    case 'PROFIT_TARGET':
      return thresholds.tpCost;
    case 'STOP_LOSS':
      // Trigger thresholds are NOT fill prices. If the stop is triggered,
      // the market is already at/through the threshold.
      return clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth);
    case 'MAX_LOSS_STOP':
      return clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth);
    case 'TRAILING_LOCK':
      // Exit at market, NOT at the floor. The floor is the trigger level,
      // not the fill level — a limit order at the floor cannot fill once the
      // market has moved past it. Same conservative principle as STOP_LOSS.
      // (The trailingFloorCost param is retained for backward compatibility
      //  with callers but no longer consulted.)
      return clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth);
    case 'PROFIT_TARGET_2':
    case 'SL_BREAKEVEN':
      return clampSpreadCloseCost(opts.overrideThresholdCost ?? currentSpreadCost, thresholds.actualWidth);
    case 'TIME_STOP':
    case 'DELTA_STOP':
    case 'NO_CHAIN':
    case 'EXPIRATION':
    case 'SIGNAL_REVERSAL':
    default:
      return clampSpreadCloseCost(currentSpreadCost, thresholds.actualWidth);
  }
}

export function updateMissingChainState(
  state: MissingChainState,
  hasValidData: boolean,
): MissingChainState {
  return {
    consecutiveMissingDays: hasValidData ? 0 : state.consecutiveMissingDays + 1,
    totalMonitoringDays: state.totalMonitoringDays + 1,
    missingMonitoringDays: state.missingMonitoringDays + (hasValidData ? 0 : 1),
  };
}

export function createMissingChainState(): MissingChainState {
  return {
    consecutiveMissingDays: 0,
    totalMonitoringDays: 0,
    missingMonitoringDays: 0,
  };
}

export function shouldExitNoChain(
  originConfig: Pick<SimConfig, 'missingChainExitAfterDays'>,
  state: MissingChainState,
): boolean {
  const threshold = originConfig.missingChainExitAfterDays ?? DEFAULT_MISSING_CHAIN_EXIT_AFTER_DAYS;
  return state.consecutiveMissingDays >= Math.max(1, threshold);
}

export function resolveCreditSpreadCommissions(
  originConfig: Pick<SimConfig, 'commissionPerLeg'>,
): { entryCommission: number; exitCommission: number } {
  const commissionPerLeg = Math.max(0, originConfig.commissionPerLeg ?? 0);
  const perSide = commissionPerLeg * CREDIT_SPREAD_LEG_COUNT;
  return {
    entryCommission: perSide,
    exitCommission: perSide,
  };
}

export function buildCreditSpreadTrade(
  params: CreditSpreadTradeBuildParams,
): OptionTrade {
  const actualWidth = resolveActualSpreadWidth(params.spread);
  const netEntryCredit = clampSpreadCloseCost(params.entryCredit, actualWidth);
  const grossEntryCredit = clampSpreadCloseCost(
    params.grossEntryCredit ?? (netEntryCredit + (params.entrySlippage ?? 0)),
    actualWidth,
  );
  const netExitCost = clampSpreadCloseCost(params.exitSpreadCost, actualWidth);
  const grossExitCost = clampSpreadCloseCost(
    params.grossExitSpreadCost ?? Math.max(0, netExitCost - (params.exitSlippage ?? 0)),
    actualWidth,
  );
  const maxLoss = Math.max(0, actualWidth - netEntryCredit);
  const grossMaxLoss = Math.max(0, actualWidth - grossEntryCredit);

  const grossRawPnl = params.overrideGrossPnl ?? (grossEntryCredit - grossExitCost) * 100;
  const grossPnl = Math.max(
    -grossMaxLoss * 100,
    Math.min(grossRawPnl, grossEntryCredit * 100),
  );

  const netRawPnl = params.overrideNetPnl ??
    ((netEntryCredit - netExitCost) * 100) -
    (params.entryCommission ?? 0) -
    (params.exitCommission ?? 0);
  const pnlPct = params.overrideNetPnlPct ?? (maxLoss > 0 ? netRawPnl / (maxLoss * 100) : 0);
  const holdDays = Math.round(
    (new Date(params.exitDate).getTime() - new Date(params.signal.date).getTime()) / 86400000,
  );

  return {
    ticker: params.signal.ticker,
    mode: 'CREDIT_SPREAD',
    direction: params.signal.direction,
    entryDate: params.signal.date,
    entrySignalScore: params.signal.score,
    strike: params.spread.short.row.strike,
    expiry: params.spread.short.row.expir_date,
    entryDTE: params.spread.short.row.dte,
    entryPrice: netEntryCredit,
    entryDelta: params.spread.short.delta,
    entryIV: params.spread.short.iv,
    entryStockPrice: params.spread.short.row.stock_price,
    longStrike: params.spread.long.row.strike,
    longEntryPrice: params.spread.long.mid,
    requestedSpreadWidth: params.spread.requestedSpreadWidth,
    spreadWidth: actualWidth,
    maxProfit: netEntryCredit,
    maxLoss,
    exitDate: params.exitDate,
    exitPrice: netExitCost,
    exitDTE: params.exitDTE,
    exitStockPrice: params.exitStockPrice,
    exitType: params.exitType,
    pnl: netRawPnl,
    grossPnl,
    pnlPct,
    holdDays,
    ivRank: params.signal.ivRank,
    entrySlippage: params.entrySlippage,
    exitSlippage: params.exitSlippage,
    entryCommission: params.entryCommission,
    exitCommission: params.exitCommission,
    fillMode: params.fillMode,
    dailyMtM: params.dailyMtM,
  };
}
