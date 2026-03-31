import type { DynamicSlippageConfig, FillMode } from './types';
import { computeSlippage } from './slippage';
import type { EntrySignal, OptionExitType, OptionTrade, SimConfig } from './option-sim';

type DebitSpreadLike = {
  spreadWidth?: number;
  long: { row: { strike: number } };
  short: { row: { strike: number } };
};

type DebitSpreadTradeSignalLike = Pick<EntrySignal, 'ticker' | 'date' | 'direction' | 'score' | 'ivRank'>;

type DebitSpreadTradeSpreadLike = DebitSpreadLike & {
  requestedLongDelta?: number;
  requestedShortDelta?: number;
  long: {
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
  short: {
    row: {
      strike: number;
    };
    mid: number;
  };
};

export interface DebitSpreadThresholds {
  actualWidth: number;
  boundedEntryDebit: number;
  maxProfit: number;
  tpValue: number;
}

export interface DebitSpreadTradeBuildParams {
  signal: DebitSpreadTradeSignalLike;
  spread: DebitSpreadTradeSpreadLike;
  entryDebit: number;
  grossEntryDebit?: number;
  exitDate: string;
  exitSpreadValue: number;
  grossExitSpreadValue?: number;
  exitDTE: number;
  exitStockPrice: number;
  exitType: OptionExitType;
  dailyMtM?: { date: string; spreadMid: number; unrealizedPnl: number }[];
  entrySlippage?: number;
  exitSlippage?: number;
  entryCommission?: number;
  exitCommission?: number;
  fillMode?: SimConfig['fillMode'];
  repricingMethod?: OptionTrade['repricingMethod'];
  syntheticDays?: number;
}

export interface DebitSpreadFillLeg {
  mid: number;
  bid: number;
  ask: number;
  oi: number;
  dte: number;
}

export function resolveActualDebitSpreadWidth(spread: DebitSpreadLike): number {
  const explicitWidth = spread.spreadWidth;
  if (explicitWidth != null && Number.isFinite(explicitWidth) && explicitWidth > 0) {
    return explicitWidth;
  }
  return Math.abs(spread.long.row.strike - spread.short.row.strike);
}

export function clampDebitSpreadValue(value: number, actualWidth: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, value), Math.max(0, actualWidth));
}

export function computeDebitSpreadThresholds(
  config: Pick<SimConfig, 'debitProfitTargetPct'>,
  spread: DebitSpreadLike,
  entryDebit: number,
): DebitSpreadThresholds {
  const actualWidth = resolveActualDebitSpreadWidth(spread);
  const boundedEntryDebit = clampDebitSpreadValue(entryDebit, actualWidth);
  const maxProfit = Math.max(0, actualWidth - boundedEntryDebit);
  const tpValue = clampDebitSpreadValue(
    boundedEntryDebit + maxProfit * (config.debitProfitTargetPct ?? 0.5),
    actualWidth,
  );

  return {
    actualWidth,
    boundedEntryDebit,
    maxProfit,
    tpValue,
  };
}

export function computeIntrinsicDebitSpreadValue(
  optionType: 'Call' | 'Put',
  longStrike: number,
  shortStrike: number,
  stockPrice: number,
  actualWidth: number,
): number {
  const longIntrinsic = optionType === 'Call'
    ? Math.max(0, stockPrice - longStrike)
    : Math.max(0, longStrike - stockPrice);
  const shortIntrinsic = optionType === 'Call'
    ? Math.max(0, stockPrice - shortStrike)
    : Math.max(0, shortStrike - stockPrice);

  return clampDebitSpreadValue(longIntrinsic - shortIntrinsic, actualWidth);
}

export function resolveTriggeredDebitExitValue(
  exitType: OptionExitType,
  currentSpreadValue: number,
  thresholds: DebitSpreadThresholds,
): number {
  if (exitType === 'PROFIT_TARGET') {
    return thresholds.tpValue;
  }
  return clampDebitSpreadValue(currentSpreadValue, thresholds.actualWidth);
}

export function applyDebitSpreadFill(
  fillMode: FillMode,
  longLeg: DebitSpreadFillLeg,
  shortLeg: DebitSpreadFillLeg,
  action: 'open' | 'close',
  config: DynamicSlippageConfig,
): { fillPrice: number; slippage: number } {
  const netMid = longLeg.mid - shortLeg.mid;
  if (fillMode === 'mid' || !config.enabled) {
    return { fillPrice: netMid, slippage: 0 };
  }

  const netBid = longLeg.bid - shortLeg.ask;
  const netAsk = longLeg.ask - shortLeg.bid;
  const spread = Math.max(0, netAsk - netBid);
  const effectiveOI = Math.min(longLeg.oi, shortLeg.oi);
  const effectiveDTE = Math.min(longLeg.dte, shortLeg.dte);
  const impact = computeSlippage(config, spread, effectiveOI, effectiveDTE, netMid);
  const halfSpread = spread / 2;

  if (action === 'open') {
    const fillPrice = netAsk + (impact - halfSpread);
    return {
      fillPrice,
      slippage: Math.max(0, fillPrice - netMid),
    };
  }

  const fillPrice = Math.max(0, netBid - (impact - halfSpread));
  return {
    fillPrice,
    slippage: Math.max(0, netMid - fillPrice),
  };
}

export function buildDebitSpreadTrade(
  params: DebitSpreadTradeBuildParams,
): OptionTrade {
  const actualWidth = resolveActualDebitSpreadWidth(params.spread);
  const netEntryDebit = clampDebitSpreadValue(params.entryDebit, actualWidth);
  const grossEntryDebit = clampDebitSpreadValue(
    params.grossEntryDebit ?? Math.max(0, netEntryDebit - (params.entrySlippage ?? 0)),
    actualWidth,
  );
  const netExitValue = clampDebitSpreadValue(params.exitSpreadValue, actualWidth);
  const grossExitValue = clampDebitSpreadValue(
    params.grossExitSpreadValue ?? (netExitValue + (params.exitSlippage ?? 0)),
    actualWidth,
  );
  const maxProfit = Math.max(0, actualWidth - netEntryDebit);
  const grossMaxProfit = Math.max(0, actualWidth - grossEntryDebit);
  const maxLoss = netEntryDebit;

  const grossPnl = Math.max(
    -grossEntryDebit * 100,
    Math.min((grossExitValue - grossEntryDebit) * 100, grossMaxProfit * 100),
  );
  const netPnl = Math.max(
    -netEntryDebit * 100,
    Math.min(
      ((netExitValue - netEntryDebit) * 100) -
      (params.entryCommission ?? 0) -
      (params.exitCommission ?? 0),
      maxProfit * 100,
    ),
  );
  const pnlPct = maxLoss > 0 ? netPnl / (maxLoss * 100) : 0;
  const holdDays = Math.round(
    (new Date(params.exitDate).getTime() - new Date(params.signal.date).getTime()) / 86400000,
  );

  return {
    ticker: params.signal.ticker,
    mode: 'DEBIT_SPREAD',
    direction: params.signal.direction,
    entryDate: params.signal.date,
    entrySignalScore: params.signal.score,
    strike: params.spread.short.row.strike,
    expiry: params.spread.long.row.expir_date,
    entryDTE: params.spread.long.row.dte,
    entryPrice: netEntryDebit,
    entryDelta: params.spread.long.delta,
    entryIV: params.spread.long.iv,
    entryStockPrice: params.spread.long.row.stock_price,
    longStrike: params.spread.long.row.strike,
    longEntryPrice: params.spread.long.mid,
    spreadWidth: actualWidth,
    maxProfit,
    maxLoss,
    exitDate: params.exitDate,
    exitPrice: netExitValue,
    exitDTE: params.exitDTE,
    exitStockPrice: params.exitStockPrice,
    exitType: params.exitType,
    pnl: netPnl,
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
    repricingMethod: params.repricingMethod,
    syntheticDays: params.syntheticDays,
  };
}
