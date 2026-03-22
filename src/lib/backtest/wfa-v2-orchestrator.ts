/**
 * WFA v2 Orchestrator — 4-Layer Validation Pipeline
 *
 * Phase 1: Setup (load data, precompute signals, build windows)
 * Phase 2: Optimization (TPE or grid search across all windows)
 * Phase 3: Statistical Validation (DSR, PBO, bootstrap, permutation)
 * Phase 4: Holdout Validation (reserved last 6 months)
 * Phase 5: Regime Analysis (VIX-based per-regime metrics)
 * Phase 6: Output (write results JSON)
 */

import type {
  WFAv2Config, WFAv2Result, WFAv2Window,
  DTEProfile,
  StatsResult, HoldoutResult,
} from './wfa-v2-types';
import { DEFAULT_WFA_V2_CONFIG } from './wfa-v2-types';
import type { OptionTrade, SimConfig, EntrySignal, SignalPresetKey } from './option-sim';
import { computeOptionAnalytics } from './option-sim';
import { buildWFAWindows } from './wfa-options';
import type { WindowDef, TradeEvaluator } from './wfa-options';
import { buildParameterSpace, runTPE, generateGrid, paramsToSimConfig } from './wfa-v2-optimizer';
import { computeDSR, computePBO, blockBootstrap, permutationTest, benjaminiHochberg, computeParameterStability } from './wfa-v2-stats';
import { buildRegimeLookup, computeRegimeMetrics } from './wfa-v2-regime';
import { computeCompositeRanking } from './wfa-v2-ranking';
import type { EvalResult } from './wfa-v2-ranking';

// ── Types ───────────────────────────────────────────────

export interface OrchestratorDeps {
  /** Pre-computed signals by preset key */
  signalsByPreset: Map<SignalPresetKey, EntrySignal[]>;
  /** All trading dates (sorted) */
  allTradingDates: string[];
  /** Synchronous trade evaluator (cache-only, no API calls) */
  evaluator: TradeEvaluator;
  /** VIX daily data for regime analysis */
  vixData: { date: string; close: number }[];
  /** Progress callback */
  onProgress?: (phase: string, detail: string) => void;
}

interface TrialAggResult {
  trialId: number;
  params: Record<string, number | string | boolean>;
  windows: WFAv2Window[];
  oosTrades: OptionTrade[];
  oosSharpe: number;
  oosWinRate: number;
  oosMaxDD: number;
  oosTotalPnl: number;
  avgTrainSharpe: number;
  wfEfficiency: number;
}

// ── Main Orchestrator ───────────────────────────────────

/**
 * Run the full WFA v2 pipeline for a single DTE profile.
 */
export function runWFAv2(
  config: WFAv2Config,
  deps: OrchestratorDeps,
  profile: DTEProfile,
): WFAv2Result {
  const t0 = Date.now();
  const log = deps.onProgress ?? (() => {});

  // ── Phase 1: Setup ──────────────────────────────────
  log('setup', 'Building WFA windows...');

  // Reserve holdout: adjust endDate to exclude last holdoutDays
  const allDates = deps.allTradingDates.filter(
    d => d >= config.startDate && d <= config.endDate
  );
  const holdoutBoundaryIdx = Math.max(0, allDates.length - config.holdoutDays);
  const holdoutStart = allDates[holdoutBoundaryIdx] ?? config.endDate;
  const wfaEndDate = allDates[holdoutBoundaryIdx - 1] ?? config.endDate;

  const windowDefs = buildWFAWindows(allDates, {
    trainWindowDays: config.trainWindowDays,
    forwardStepDays: config.forwardStepDays,
    purgeGapDays: config.purgeGapDays,
    mode: config.mode,
    startDate: config.startDate,
    endDate: wfaEndDate,
  });

  log('setup', `Built ${windowDefs.length} windows, holdout starts ${holdoutStart}`);

  // ── Phase 2: Optimization ───────────────────────────
  log('optimize', `Starting ${config.optimizerMode} optimization for ${profile} profile...`);

  const space = buildParameterSpace(profile);
  const trialResults: TrialAggResult[] = [];
  let trialCounter = 0;

  const evaluateTrial = (params: Record<string, number | string | boolean>): number => {
    const simConfig = paramsToSimConfig(params, profile);
    const trialId = trialCounter++;
    const result = evaluateAllWindows(
      trialId, simConfig, params, windowDefs, deps, config,
    );
    trialResults.push(result);
    return result.wfEfficiency > 0
      ? result.oosSharpe * Math.sqrt(result.wfEfficiency)
      : result.oosSharpe * 0.5;
  };

  if (config.optimizerMode === 'tpe') {
    const tpeResult = runTPE(space, evaluateTrial, config.tpeConfig, (trial, total, best) => {
      if (trial % 50 === 0 || trial === total) {
        log('optimize', `Trial ${trial}/${total}, best objective: ${best.toFixed(3)}`);
      }
    });
    log('optimize', `TPE complete: ${tpeResult.allTrials.length} trials, best objective ${tpeResult.bestObjective.toFixed(3)}`);
  } else {
    // Grid search
    const gridCombos = generateGrid(config.gridConfig!, profile);
    log('optimize', `Grid search: ${gridCombos.length} combinations`);
    for (let i = 0; i < gridCombos.length; i++) {
      evaluateTrial(gridCombos[i]);
      if ((i + 1) % 10 === 0) {
        log('optimize', `Grid ${i + 1}/${gridCombos.length}`);
      }
    }
  }

  // Sort by composite objective (Sharpe * sqrt(WFE))
  trialResults.sort((a, b) => {
    const aObj = a.wfEfficiency > 0 ? a.oosSharpe * Math.sqrt(a.wfEfficiency) : a.oosSharpe * 0.5;
    const bObj = b.wfEfficiency > 0 ? b.oosSharpe * Math.sqrt(b.wfEfficiency) : b.oosSharpe * 0.5;
    return bObj - aObj;
  });

  const bestTrial = trialResults[0];
  if (!bestTrial) {
    throw new Error('No valid trials completed');
  }

  log('optimize', `Best: Sharpe=${bestTrial.oosSharpe.toFixed(2)}, WR=${bestTrial.oosWinRate.toFixed(1)}%, DD=${bestTrial.oosMaxDD.toFixed(1)}%, WFE=${bestTrial.wfEfficiency.toFixed(3)}`);

  // ── Phase 3: Statistical Validation ─────────────────
  log('stats', 'Running statistical validation...');

  const oosReturns = bestTrial.oosTrades.map(t => t.pnlPct);
  const perWindowReturns = bestTrial.windows.map(w => w.oosTrades.map(t => t.pnlPct));

  // DSR
  const dsr = computeDSR(bestTrial.oosSharpe, trialResults.length, oosReturns);
  log('stats', `DSR: ${dsr.dsr.toFixed(3)} (expected max SR: ${dsr.expectedMaxSR.toFixed(2)} from ${dsr.nTrials} trials)`);

  // PBO
  const pbo = computePBO(perWindowReturns, config.cscvBlocks, config.maxCscvCombinations);
  log('stats', `PBO: ${pbo.pbo.toFixed(3)} (${pbo.nCombinations} combinations)`);

  // Block bootstrap
  const bootstrap = blockBootstrap(
    bestTrial.oosTrades,
    config.bootstrapResamples,
    5,
    config.startingCapital,
  );
  log('stats', `Bootstrap Sharpe CI: [${bootstrap.sharpe.ci5.toFixed(2)}, ${bootstrap.sharpe.ci95.toFixed(2)}]`);

  // Permutation test
  const permResult = permutationTest(bestTrial.oosTrades, 10_000, config.startingCapital);
  log('stats', `Permutation p-value: ${permResult.pValue.toFixed(4)}`);

  // BH correction on top 20
  const top20 = trialResults.slice(0, Math.min(20, trialResults.length));
  const dsrPValues = top20.map((t) => {
    const returns = t.oosTrades.map(tr => tr.pnlPct);
    const dsrRes = computeDSR(t.oosSharpe, trialResults.length, returns);
    return { configId: `trial_${t.trialId}`, pValue: 1 - dsrRes.dsr };
  });
  const bhCorrected = benjaminiHochberg(dsrPValues);

  // Parameter stability
  const numericParams = [
    'creditShortDelta', 'creditSpreadWidth', 'creditProfitTarget',
    'creditStopLossMultiple', 'creditTimeStopDTE', 'minIVRank',
  ];
  const paramStability = computeParameterStability(bestTrial.windows, numericParams);
  const avgCV = paramStability.length > 0
    ? paramStability.reduce((s, p) => s + p.cv, 0) / paramStability.length : 0;
  const stability = Math.max(0, 1 - avgCV);

  const stats: StatsResult = {
    dsr,
    pbo,
    bootstrap,
    permutationPValue: permResult.pValue,
    permutation: permResult,
    bhCorrected,
    paramStability,
  };

  // ── Phase 4: Holdout Validation ─────────────────────
  log('holdout', 'Running holdout validation...');

  const holdout = evaluateHoldout(
    bestTrial, holdoutStart, config.endDate, deps, config,
  );
  log('holdout', `Holdout: Sharpe=${holdout.sharpe.toFixed(2)}, WR=${holdout.winRate.toFixed(1)}%, degradation=${holdout.degradation.toFixed(2)}`);

  if (holdout.degradation < 0.50) {
    log('holdout', '⚠ WARNING: Holdout Sharpe < 50% of OOS Sharpe — possible overfitting');
  }

  // ── Phase 5: Regime Analysis ────────────────────────
  log('regime', 'Running regime analysis...');

  const vixLookup = buildRegimeLookup(deps.vixData);
  const regimes = computeRegimeMetrics(
    bestTrial.oosTrades, vixLookup, config.startingCapital,
  );

  for (const r of regimes) {
    log('regime', `${r.regime.toUpperCase()}: ${r.tradeCount} trades, Sharpe=${r.sharpe.toFixed(2)}, WR=${r.winRate.toFixed(1)}%`);
  }

  // ── Phase 6: Ranking & Output ───────────────────────
  log('ranking', 'Computing composite ranking...');

  const evalResults: EvalResult[] = trialResults.slice(0, Math.min(50, trialResults.length)).map(t => {
    const trialReturns = t.oosTrades.map(tr => tr.pnlPct);
    const trialDSR = computeDSR(t.oosSharpe, trialResults.length, trialReturns);
    return {
      configId: `trial_${t.trialId}`,
      params: t.params,
      sharpe: t.oosSharpe,
      maxDD: t.oosMaxDD,
      wfe: t.wfEfficiency,
      stability,
      dsr: trialDSR.dsr,
      winRate: t.oosWinRate,
      totalPnl: t.oosTotalPnl,
      tradeCount: t.oosTrades.length,
    };
  });

  const ranking = computeCompositeRanking(evalResults);
  const paretoFrontier = ranking.filter(r => r.isParetoOptimal);

  // Build equity curve
  const sortedTrades = [...bestTrial.oosTrades].sort(
    (a, b) => a.exitDate.localeCompare(b.exitDate)
  );
  let equity = config.startingCapital;
  const equityCurve: { date: string; equity: number }[] = [];
  for (const t of sortedTrades) {
    equity += t.pnl;
    equityCurve.push({ date: t.exitDate, equity });
  }

  const bestConfig = paramsToSimConfig(bestTrial.params, profile);

  const result: WFAv2Result = {
    oos: {
      windows: bestTrial.windows,
      allTrades: bestTrial.oosTrades,
      sharpe: bestTrial.oosSharpe,
      winRate: bestTrial.oosWinRate,
      maxDD: bestTrial.oosMaxDD,
      totalPnl: bestTrial.oosTotalPnl,
      wfEfficiency: bestTrial.wfEfficiency,
      equityCurve,
      metricBasis: bestTrial.oosTrades.some(t => t.dailyMtM && t.dailyMtM.length > 0)
        ? 'daily_portfolio' : 'trade_hold_legacy',
    },
    holdout,
    stats,
    regimes,
    bestConfig,
    ranking,
    paretoFrontier,
    dteProfile: profile,
    totalEvaluations: trialResults.length,
    elapsedMs: Date.now() - t0,
  };

  log('done', `Complete in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${trialResults.length} evaluations`);

  return result;
}

// ── Internal Helpers ────────────────────────────────────

/**
 * Apply portfolio constraints (max positions, max per ticker) to a stream of signals.
 */
function evaluateWithConstraints(
  signals: EntrySignal[],
  simConfig: SimConfig,
  maxPositions: number,
  maxPerTicker: number,
  evaluator: TradeEvaluator,
  allTradingDates: string[],
  maxDate: string,
): OptionTrade[] {
  const trades: OptionTrade[] = [];
  const openPositions: OptionTrade[] = [];
  for (const signal of signals) {
    if (openPositions.length >= maxPositions) continue;
    if (openPositions.filter(t => t.ticker === signal.ticker).length >= maxPerTicker) continue;
    const trade = evaluator(signal, simConfig, allTradingDates, maxDate);
    if (trade) {
      trades.push(trade);
      openPositions.push(trade);
      for (let j = openPositions.length - 1; j >= 0; j--) {
        if (openPositions[j].exitDate <= signal.date) openPositions.splice(j, 1);
      }
    }
  }
  return trades;
}

/**
 * Evaluate a single trial config across all WFA windows.
 */
function evaluateAllWindows(
  trialId: number,
  simConfig: SimConfig,
  params: Record<string, number | string | boolean>,
  windowDefs: WindowDef[],
  deps: OrchestratorDeps,
  config: WFAv2Config,
): TrialAggResult {
  const presetKey = simConfig.signalWeightPreset ?? 'ema';
  const allSignals = deps.signalsByPreset.get(presetKey) ?? [];
  const maxPerTicker = (params.maxPerTicker as number) ?? 5;
  const maxPositions = (params.maxPositions as number) ?? 10;

  const windows: WFAv2Window[] = [];
  const allOOSTrades: OptionTrade[] = [];
  let totalTrainSharpe = 0;

  for (let i = 0; i < windowDefs.length; i++) {
    const w = windowDefs[i];

    // Training evaluation
    const trainSignals = allSignals.filter(s => s.date >= w.trainStart && s.date <= w.trainEnd);
    const trainTrades: OptionTrade[] = [];
    for (const signal of trainSignals) {
      const trade = deps.evaluator(signal, simConfig, deps.allTradingDates, w.trainEnd);
      if (trade) trainTrades.push(trade);
    }
    const trainAnalytics = computeOptionAnalytics(trainTrades);

    // OOS evaluation with portfolio constraints
    const oosSignals = allSignals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
    const oosTrades = evaluateWithConstraints(
      oosSignals, simConfig, maxPositions, maxPerTicker,
      deps.evaluator, deps.allTradingDates, config.endDate,
    );

    const oosAnalytics = computeOptionAnalytics(oosTrades);
    totalTrainSharpe += trainAnalytics.sharpe;

    windows.push({
      windowIndex: i,
      trainStart: w.trainStart,
      trainEnd: w.trainEnd,
      oosStart: w.oosStart,
      oosEnd: w.oosEnd,
      bestConfig: simConfig,
      bestTrainSharpe: trainAnalytics.sharpe,
      trainTradeCount: trainTrades.length,
      oosTrades,
      oosSharpe: oosAnalytics.sharpe,
      oosWinRate: oosAnalytics.winRate,
      oosMaxDD: oosAnalytics.maxDrawdown,
      oosTradeCount: oosTrades.length,
    });

    allOOSTrades.push(...oosTrades);
  }

  const oosAllAnalytics = computeOptionAnalytics(allOOSTrades);
  const avgTrainSharpe = windowDefs.length > 0 ? totalTrainSharpe / windowDefs.length : 0;

  return {
    trialId,
    params,
    windows,
    oosTrades: allOOSTrades,
    oosSharpe: oosAllAnalytics.sharpe,
    oosWinRate: oosAllAnalytics.winRate,
    oosMaxDD: oosAllAnalytics.maxDrawdown,
    oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
    avgTrainSharpe,
    wfEfficiency: avgTrainSharpe >= 0.1 ? oosAllAnalytics.sharpe / avgTrainSharpe : 0,
  };
}

/**
 * Evaluate the best trial's config on the holdout period.
 */
function evaluateHoldout(
  bestTrial: TrialAggResult,
  holdoutStart: string,
  holdoutEnd: string,
  deps: OrchestratorDeps,
  config: WFAv2Config,
): HoldoutResult {
  const simConfig = paramsToSimConfig(bestTrial.params, config.dteProfile as DTEProfile);
  const presetKey = simConfig.signalWeightPreset ?? 'ema';
  const allSignals = deps.signalsByPreset.get(presetKey) ?? [];
  const holdoutSignals = allSignals.filter(s => s.date >= holdoutStart && s.date <= holdoutEnd);
  const maxPerTicker = (bestTrial.params.maxPerTicker as number) ?? 5;
  const maxPositions = (bestTrial.params.maxPositions as number) ?? 10;

  const trades = evaluateWithConstraints(
    holdoutSignals, simConfig, maxPositions, maxPerTicker,
    deps.evaluator, deps.allTradingDates, holdoutEnd,
  );

  const analytics = computeOptionAnalytics(trades);
  const degradation = bestTrial.oosSharpe > 0 ? analytics.sharpe / bestTrial.oosSharpe : 0;

  return {
    trades,
    sharpe: analytics.sharpe,
    winRate: analytics.winRate,
    maxDD: analytics.maxDrawdown,
    totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
    tradeCount: trades.length,
    degradation,
  };
}

// ── Convenience: Run both profiles ──────────────────────

/**
 * Run WFA v2 for both swing and short-term profiles.
 */
export function runWFAv2Both(
  config: WFAv2Config,
  deps: OrchestratorDeps,
): { swing: WFAv2Result; short: WFAv2Result } {
  const swingResult = runWFAv2({ ...config, dteProfile: 'swing' }, deps, 'swing');
  const shortResult = runWFAv2({ ...config, dteProfile: 'short' }, deps, 'short');
  return { swing: swingResult, short: shortResult };
}

// ── Export default config ───────────────────────────────

export { DEFAULT_WFA_V2_CONFIG };
