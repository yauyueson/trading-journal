/**
 * Fill mode confirmation test.
 * Runs vol|tp50|w2.5|iv0|d45|ts1|pm3 (March 24 rank #1) with both mid and bidask fills
 * to determine whether the Sharpe gap is explained by fill model alone.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';

const __dirname_early = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.resolve(__dirname_early, '../.env') });
dotenvConfig({ path: path.resolve(__dirname_early, '../.env.local'), override: true });

import { SIGNAL_PRESETS } from '../src/lib/backtest/types';
import { precomputeSignals4H, type IVDataRow } from '../src/lib/backtest/intraday-signals';
import { aggregateToDaily } from '../src/lib/backtest/intraday-cache';
import { computeIVRankMinMax } from '../src/lib/backtest/iv-rank';
import { DEFAULT_SHORT_CREDIT_CONFIG, type SimConfig, type SignalPresetKey } from '../src/lib/backtest/option-sim';
import type { FillMode } from '../src/lib/backtest/types';
import { DEFAULT_DYNAMIC_SLIPPAGE } from '../src/lib/backtest/types';
import { buildWFAWindows, type PortfolioExecutionConfig, evaluateConfiguredSignalsWithConstraints, computePortfolioDailyMetrics, type ConfiguredSignal } from '../src/lib/backtest/wfa-options';
import { initIntradayDB, get130MCandles } from '../src/lib/backtest/intraday-cache';
import { initDB, closeDB, getCachedChain, findSpreadStrikes, findContractDirect } from '../src/lib/backtest/chain-cache';
import { buildCreditSpreadTrade, clampSpreadCloseCost, computeCreditSpreadThresholds, computeIntrinsicSpreadCloseCost, createMissingChainState, resolveCreditSpreadCommissions, resolveTriggeredCreditExitCost, shouldExitNoChain, updateMissingChainState } from '../src/lib/backtest/credit-spread-exit';
import { applyFill, applySpreadFill } from '../src/lib/backtest/slippage';
import { DIR_CONF_THRESHOLDS } from '../src/lib/backtest/types';
import { computeOptionAnalytics, type OptionTrade, type OptionExitType } from '../src/lib/backtest/option-sim';

const TICKERS = ['SPY', 'QQQ', 'AMD', 'IWM', 'TSLA', 'AAPL', 'JPM', 'NVDA', 'AMZN', 'MSFT', 'META', 'NFLX', 'GOOG', 'GS'];
const DATA_START = '2019-06-01';
const START_DATE = '2020-01-01';
const END_DATE = '2026-02-28';
const COMMISSION = 0.65;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

async function fetchIVData(ticker: string): Promise<IVDataRow[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const url = `${SUPABASE_URL}/rest/v1/orats_iv_cache?select=date,iv30d,iv60d,hv20d,hv30d,hv60d&ticker=eq.${ticker}&date=gte.${DATA_START}&date=lte.${END_DATE}&order=date.asc&limit=5000`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) return [];
  const rows: any[] = await res.json();
  return rows.map(r => ({ date: r.date as string, iv30d: r.iv30d as number | null, iv60d: r.iv60d as number | null, hv20d: r.hv20d as number | null, hv30d: r.hv30d as number | null, hv60d: r.hv60d as number | null }));
}

// Production config (em|tp50|w10|iv20|dsoff|pm2.25) from CLAUDE.md
const TARGET_CONFIG = {
  preset: 'em' as SignalPresetKey,
  pm: 2.25,
  tp: 0.50,
  width: 10,
  ivMin: 20,
  delta: 0.45,
  tsdte: 1,
};

const WFA_PARAMS = {
  trainWindowDays: 189,
  forwardStepDays: 42,
  purgeGapDays: 14,
  holdoutCount: 2,
  maxPositions: 10,
  maxPerTicker: 5,
  startingCapital: 100_000,
};

function makeEvaluator(fillMode: FillMode, commissionPerLeg: number) {
  return (signal: any, config: SimConfig, allDates: string[], maxDate: string): OptionTrade | null => {
    const entryChain = getCachedChain(signal.ticker, signal.date);
    if (entryChain.length === 0) return null;

    const optionType: 'Call' | 'Put' = signal.direction === 'CALL' ? 'Put' : 'Call';
    const spread = findSpreadStrikes(entryChain, config.creditShortDelta, config.creditSpreadWidth, optionType, config.creditDTERange);
    if (!spread || spread.netCredit <= 0) return null;
    if (config.minIVRank > 0 && signal.ivRank != null && signal.ivRank < config.minIVRank) return null;

    const grossEntryCredit = spread.netCredit;
    let entryCredit = grossEntryCredit;
    let entrySlippage = 0;
    const slippageConfig = { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: fillMode === 'bidask', executionStyle: 'combo' as const };
    const simConfig = { ...config, fillMode, slippage: slippageConfig, commissionPerLeg };
    const { entryCommission, exitCommission } = resolveCreditSpreadCommissions(simConfig);

    if (fillMode === 'bidask' && slippageConfig.enabled) {
      const spreadFill = applySpreadFill('bidask', { ...spread.short, dte: spread.short.row.dte }, { ...spread.long, dte: spread.long.row.dte }, 'open', slippageConfig);
      entryCredit = spreadFill.fillPrice;
      entrySlippage = spreadFill.slippage;
      if (entryCredit <= 0) return null;
    }

    const thresholds = computeCreditSpreadThresholds(simConfig, spread, entryCredit);
    let trailingFloorActive = false;
    let trailingFloorCost = Infinity;
    let missingChainState = createMissingChainState();
    let lastValidSpreadCost: number | null = null;

    const monitorEnd = spread.short.row.expir_date < maxDate ? spread.short.row.expir_date : maxDate;
    const startIdx = allDates.indexOf(signal.date);
    if (startIdx < 0) return null;
    const monitorDates: string[] = [];
    for (let i = startIdx + 1; i < allDates.length; i++) {
      if (allDates[i] > monitorEnd) break;
      monitorDates.push(allDates[i]);
    }

    const dailyMtM: { date: string; spreadMid: number; unrealizedPnl: number }[] = [];

    for (const checkDate of monitorDates) {
      const shortLeg = findContractDirect(signal.ticker, checkDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
      const longLeg = findContractDirect(signal.ticker, checkDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
      const fallbackChain = (!shortLeg || !longLeg) ? getCachedChain(signal.ticker, checkDate) : [];
      const monitoringStockPrice = shortLeg?.row.stock_price ?? longLeg?.row.stock_price ?? fallbackChain[0]?.stock_price;
      const hasValidLegs = Boolean(shortLeg && longLeg);
      missingChainState = updateMissingChainState(missingChainState, hasValidLegs);

      if (!hasValidLegs) {
        if (shouldExitNoChain(simConfig, missingChainState)) {
          const intrinsicCost = monitoringStockPrice != null ? computeIntrinsicSpreadCloseCost(optionType, spread.short.row.strike, spread.long.row.strike, monitoringStockPrice, thresholds.actualWidth) : null;
          const exitCost = resolveTriggeredCreditExitCost('NO_CHAIN', Math.max(lastValidSpreadCost ?? thresholds.boundedEntryCredit, intrinsicCost ?? thresholds.boundedEntryCredit), thresholds);
          return buildCreditSpreadTrade({ signal, spread, entryCredit, grossEntryCredit, exitDate: checkDate, exitSpreadCost: exitCost, grossExitSpreadCost: exitCost, exitDTE: 0, exitStockPrice: monitoringStockPrice ?? spread.short.row.stock_price, exitType: 'NO_CHAIN', dailyMtM, entrySlippage, entryCommission, exitCommission, fillMode });
        }
        continue;
      }

      const grossCurrentSpreadCost = clampSpreadCloseCost(shortLeg!.mid - longLeg!.mid, thresholds.actualWidth);
      let currentSpreadCost = grossCurrentSpreadCost;
      let exitSlippageAmount = 0;
      if (fillMode === 'bidask' && slippageConfig.enabled) {
        const spreadFill = applySpreadFill('bidask', { ...shortLeg!, dte: shortLeg!.row.dte }, { ...longLeg!, dte: longLeg!.row.dte }, 'close', slippageConfig);
        currentSpreadCost = clampSpreadCloseCost(spreadFill.fillPrice, thresholds.actualWidth);
        exitSlippageAmount = spreadFill.slippage;
      }

      const currentDTE = shortLeg!.row.dte;
      lastValidSpreadCost = currentSpreadCost;
      dailyMtM.push({ date: checkDate, spreadMid: currentSpreadCost, unrealizedPnl: (entryCredit - currentSpreadCost) * 100 });

      // Exit checks — same order as wfa-sweep-worker.ts
      if (grossCurrentSpreadCost <= thresholds.tpCost) {
        const exitCost = resolveTriggeredCreditExitCost('PROFIT_TARGET', grossCurrentSpreadCost, thresholds);
        const netExit = clampSpreadCloseCost(exitCost + exitSlippageAmount, thresholds.actualWidth);
        return buildCreditSpreadTrade({ signal, spread, entryCredit, grossEntryCredit, exitDate: checkDate, exitSpreadCost: netExit, grossExitSpreadCost: exitCost, exitDTE: currentDTE, exitStockPrice: monitoringStockPrice ?? spread.short.row.stock_price, exitType: 'PROFIT_TARGET', dailyMtM, entrySlippage, exitSlippage: exitSlippageAmount, entryCommission, exitCommission, fillMode });
      }
      if (grossCurrentSpreadCost >= thresholds.slCost) {
        const exitCost = resolveTriggeredCreditExitCost('STOP_LOSS', grossCurrentSpreadCost, thresholds);
        const netExit = clampSpreadCloseCost(exitCost + exitSlippageAmount, thresholds.actualWidth);
        return buildCreditSpreadTrade({ signal, spread, entryCredit, grossEntryCredit, exitDate: checkDate, exitSpreadCost: netExit, grossExitSpreadCost: exitCost, exitDTE: currentDTE, exitStockPrice: monitoringStockPrice ?? spread.short.row.stock_price, exitType: 'STOP_LOSS', dailyMtM, entrySlippage, exitSlippage: exitSlippageAmount, entryCommission, exitCommission, fillMode });
      }
      if (currentDTE <= (config.creditTimeStopDTE || 1)) {
        const exitCost = resolveTriggeredCreditExitCost('TIME_STOP', grossCurrentSpreadCost, thresholds);
        const netExit = clampSpreadCloseCost(exitCost + exitSlippageAmount, thresholds.actualWidth);
        return buildCreditSpreadTrade({ signal, spread, entryCredit, grossEntryCredit, exitDate: checkDate, exitSpreadCost: netExit, grossExitSpreadCost: exitCost, exitDTE: currentDTE, exitStockPrice: monitoringStockPrice ?? spread.short.row.stock_price, exitType: 'TIME_STOP', dailyMtM, entrySlippage, exitSlippage: exitSlippageAmount, entryCommission, exitCommission, fillMode });
      }
    }

    // Expiration
    const lastDate = monitorDates[monitorDates.length - 1] ?? signal.date;
    const lastShort = findContractDirect(signal.ticker, lastDate, spread.short.row.strike, spread.short.row.expir_date, optionType);
    const lastLong = findContractDirect(signal.ticker, lastDate, spread.long.row.strike, spread.long.row.expir_date, optionType);
    const lastStockPrice = lastShort?.row.stock_price ?? lastLong?.row.stock_price ?? spread.short.row.stock_price;
    const finalCost = lastShort && lastLong ? clampSpreadCloseCost(lastShort.mid - lastLong.mid, thresholds.actualWidth) : lastValidSpreadCost ?? thresholds.boundedEntryCredit;
    const pnl = (thresholds.boundedEntryCredit - finalCost) * 100;
    return buildCreditSpreadTrade({ signal, spread, entryCredit, grossEntryCredit, exitDate: lastDate, exitSpreadCost: finalCost, grossExitSpreadCost: finalCost, exitDTE: 0, exitStockPrice: lastStockPrice, exitType: 'EXPIRATION', overrideNetPnl: pnl, overrideNetPnlPct: thresholds.maxLoss > 0 ? pnl / (thresholds.maxLoss * 100) : 0, dailyMtM, entrySlippage, entryCommission, exitCommission, fillMode });
  };
}

async function runForFillMode(fillMode: FillMode, commissionPerLeg: number): Promise<{ sharpe: number; wr: number; trades: number; pnl: number }> {
  const intradayDb = initIntradayDB();
  const allDatesSet = new Set<string>();
  const signalMap = new Map<string, any[]>();

  process.stdout.write(`  Loading data (${fillMode})...`);
  for (const ticker of TICKERS) {
    const candles = get130MCandles(intradayDb, ticker, DATA_START, END_DATE);
    for (const c of candles) { if (c.date >= START_DATE && c.date <= END_DATE) allDatesSet.add(c.date); }
    const ivData = await fetchIVData(ticker);
    const techOptions = SIGNAL_PRESETS[TARGET_CONFIG.preset];
    const rawSignals = precomputeSignals4H(candles, ivData, TARGET_CONFIG.pm, techOptions);
    const dailyCandles = aggregateToDaily(candles);
    const ivByDate = new Map(ivData.map(r => [r.date, r.iv30d]));
    const ivSeries = dailyCandles.map(c => ivByDate.get(c.date) ?? null);
    const ivRanks = computeIVRankMinMax(ivSeries);
    const dateToIdx = new Map(dailyCandles.map((c, i) => [c.date, i]));
    const deduped = new Map<string, any>();
    for (const sig of rawSignals) {
      const barDate = sig.date.split('T')[0].split(' ')[0];
      if (barDate < START_DATE || barDate > END_DATE) continue;
      if (sig.type === 'NEUTRAL' || sig.score < 65) continue;
      if (sig.adx !== undefined && sig.adx < 8) continue;
      const idx = dateToIdx.get(barDate);
      const ivRank = idx != null ? (ivRanks[idx] ?? undefined) : undefined;
      const entry = { ticker, date: barDate, direction: sig.type as 'CALL' | 'PUT', score: sig.score, ivRank };
      const key = `${ticker}|${barDate}|${sig.type}`;
      if (!deduped.has(key) || entry.score > deduped.get(key)!.score) deduped.set(key, entry);
    }
    signalMap.set(ticker, [...deduped.values()]);
  }

  const allTradingDates = Array.from(allDatesSet).sort();
  const allWindows = buildWFAWindows(allTradingDates, { trainWindowDays: WFA_PARAMS.trainWindowDays, forwardStepDays: WFA_PARAMS.forwardStepDays, purgeGapDays: WFA_PARAMS.purgeGapDays, mode: 'rolling', startDate: START_DATE, endDate: END_DATE });
  const selectionWindows = allWindows.slice(0, -WFA_PARAMS.holdoutCount);

  const slippageConfig = { ...DEFAULT_DYNAMIC_SLIPPAGE, enabled: fillMode === 'bidask', executionStyle: 'combo' as const };
  const config: SimConfig = { ...DEFAULT_SHORT_CREDIT_CONFIG, creditShortDelta: TARGET_CONFIG.delta, creditSpreadWidth: TARGET_CONFIG.width, creditProfitTarget: TARGET_CONFIG.tp, creditTimeStopDTE: TARGET_CONFIG.tsdte, minIVRank: TARGET_CONFIG.ivMin, creditDTERange: [7, 21], creditStopLossMultiple: 100, signalWeightPreset: TARGET_CONFIG.preset, indicatorPeriodMultiplier: TARGET_CONFIG.pm, bsmKappa: 4.0, bsmRiskFreeRate: 0.04, dailyCalibration: true, ivThetaSource: 'hv60' as const, fillMode, slippage: slippageConfig, commissionPerLeg };

  const executionConfig: PortfolioExecutionConfig = { maxPositions: WFA_PARAMS.maxPositions, maxPerTicker: WFA_PARAMS.maxPerTicker, startingCapital: WFA_PARAMS.startingCapital };
  const evaluator = makeEvaluator(fillMode, commissionPerLeg);

  const allOOSTrades: OptionTrade[] = [];
  for (const w of selectionWindows) {
    const oosSigs: any[] = [];
    for (const [, sigs] of signalMap) {
      oosSigs.push(...sigs.filter((s: any) => s.date >= w.oosStart && s.date <= w.oosEnd));
    }
    const configured: ConfiguredSignal[] = oosSigs.map(s => ({ signal: s, config }));
    const trades = evaluateConfiguredSignalsWithConstraints(configured, executionConfig, allTradingDates, w.oosEnd, evaluator);
    allOOSTrades.push(...trades);
  }

  const oosStart = selectionWindows[0].oosStart;
  const oosEnd = selectionWindows[selectionWindows.length - 1].oosEnd;
  const metrics = computePortfolioDailyMetrics(allOOSTrades, allTradingDates, oosStart, oosEnd, WFA_PARAMS.startingCapital);
  const analytics = computeOptionAnalytics(allOOSTrades);

  // Exit type breakdown
  const exitCounts: Record<string, number> = {};
  for (const t of allOOSTrades) { exitCounts[t.exitType] = (exitCounts[t.exitType] || 0) + 1; }
  process.stdout.write(' done\n');
  console.log(`    Exits: ${Object.entries(exitCounts).map(([k,v]) => `${k}=${v}`).join(' ')}`);

  return { sharpe: metrics.sharpe, wr: analytics.winRate, trades: allOOSTrades.length, pnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0) };
}

async function main() {
  console.log('Fill Mode Confirmation Test');
  console.log('Config: em|tp50|w10|iv20|dsoff|pm2.25 (production config)');
  console.log('═'.repeat(60));

  initDB();

  const midResult = await runForFillMode('mid', 0);
  const bidaskResult = await runForFillMode('bidask', COMMISSION);

  console.log('\nResults:');
  console.log('─'.repeat(60));
  console.log(`  mid   fills, $0/leg commission:   Sharpe ${midResult.sharpe.toFixed(3)}, WR ${midResult.wr.toFixed(1)}%, Trades ${midResult.trades}, PnL $${midResult.pnl.toFixed(0)}`);
  console.log(`  bidask fills, $${COMMISSION}/leg commission: Sharpe ${bidaskResult.sharpe.toFixed(3)}, WR ${bidaskResult.wr.toFixed(1)}%, Trades ${bidaskResult.trades}, PnL $${bidaskResult.pnl.toFixed(0)}`);
  console.log('─'.repeat(60));
  console.log(`  Sharpe gap: ${(midResult.sharpe - bidaskResult.sharpe).toFixed(3)}`);
  console.log(`  README reported OOS Sharpe (bidask): 2.0-3.1`);

  closeDB();
}

main().catch(console.error);
