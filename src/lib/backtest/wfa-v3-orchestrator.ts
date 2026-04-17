/**
 * WFA v3 Orchestrator — 6-Phase Intraday Pipeline
 *
 * Same 6-phase structure as v2, but uses:
 * - 4H signals from intraday-signals.ts
 * - BSM-based 4H exit monitoring from intraday-monitor.ts
 * - Shorter WFA windows (252d train / 63d step / 21d purge)
 *
 * Reuses: buildWFAWindows, stats, regime, ranking from v2 modules.
 */

import type {
  WFAv3Config,
  WFAv3Result,
  SignalPresetKey,
  SimConfig,
  EntrySignal,
  OptionTrade,
} from './wfa-v3-types';
import type { WFAv2Window, StatsResult, HoldoutResult } from './wfa-v2-types';
import type { PeriodMultiplier } from './intraday-signals';
import type { EvalResult } from './wfa-v2-ranking';

import { buildWFAWindows, computePortfolioDailyMetrics } from './wfa-options';
import { computeOptionAnalytics } from './option-sim';
import { computeDSR, computePBO, blockBootstrap, permutationTest, benjaminiHochberg, computeParameterStability } from './wfa-v2-stats';
import { buildRegimeLookup, computeRegimeMetrics } from './wfa-v2-regime';
import { computeCompositeRanking } from './wfa-v2-ranking';
import { v3ParamsToSimConfig, extractPeriodMultiplier } from './wfa-v3-optimizer';

// ── Types ───────────────────────────────────────────────

export interface V3OrchestratorDeps {
  /** Pre-computed signals by (periodMultiplier, presetKey) */
  signalsByMultPreset: Map<string, EntrySignal[]>;
  /** All trading dates (sorted) */
  allTradingDates: string[];
  /** Trade evaluator: evaluates a signal → OptionTrade using 4H monitoring */
  evaluator: (signal: EntrySignal, config: SimConfig, allTradingDates: string[], maxDate: string) => OptionTrade | null;
  /** VIX daily data for regime analysis */
  vixData: { date: string; close: number }[];
  /** Progress callback */
  onProgress?: (phase: string, detail: string) => void;
}

export interface TrialAggResult {
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

// ── Signal Key Helper ───────────────────────────────────

/** Build lookup key for signalsByMultPreset map */
export function signalMapKey(mult: PeriodMultiplier, preset: SignalPresetKey): string {
  return `${mult}|${preset}`;
}

// ── Main Orchestrator ───────────────────────────────────

/**
 * Run the full WFA v3 pipeline.
 * Returns a WFAv3Result with intraday metadata.
 */
export function runWFAv3(
  config: WFAv3Config,
  deps: V3OrchestratorDeps,
): WFAv3Result {
  const log = deps.onProgress ?? (() => {});

  // ── Phase 1: Setup ──────────────────────────────────
  log('setup', 'Building WFA windows...');

  const allDates = deps.allTradingDates.filter(
    d => d >= config.startDate && d <= config.endDate,
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
  log('optimize', 'Starting optimization...');

  const trialResults: TrialAggResult[] = [];
  let trialCounter = 0;

  /**
   * Evaluate a single trial config across all WFA windows.
   * This is called by the external optimizer (GA/TPE/grid in the runner script).
   */
  const evaluateTrial = (params: Record<string, number | string | boolean>): TrialAggResult => {
    const simConfig = v3ParamsToSimConfig(params);
    const periodMult = extractPeriodMultiplier(params);
    const presetKey = simConfig.signalWeightPreset ?? 'ema';
    const allSignals = deps.signalsByMultPreset.get(signalMapKey(periodMult, presetKey)) ?? [];
    const maxPerTicker = (params.maxPerTicker as number) ?? 5;
    const maxPositions = (params.maxPositions as number) ?? 10;
    const trialId = trialCounter++;

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
      const trainSharpe = trainAnalytics.dailyPortfolioSharpe ?? trainAnalytics.tradeSharpeLegacy;

      // OOS evaluation with portfolio constraints
      const oosSignals = allSignals.filter(s => s.date >= w.oosStart && s.date <= w.oosEnd);
      const oosTrades: OptionTrade[] = [];
      const openPositions: OptionTrade[] = [];

      for (const signal of oosSignals) {
        // Clean up expired positions
        for (let j = openPositions.length - 1; j >= 0; j--) {
          if (openPositions[j].exitDate <= signal.date) openPositions.splice(j, 1);
        }
        // Portfolio constraints
        if (openPositions.length >= maxPositions) continue;
        const tickerCount = openPositions.filter(t => t.ticker === signal.ticker).length;
        if (tickerCount >= maxPerTicker) continue;

        // Cap maxDate at wfaEndDate (pre-holdout boundary) so trade lifecycles cannot
        // bleed PnL from the holdout period into selection metrics.
        // (See docs/backtest-trust-gotchas.md / Codex finding T2-2.)
        const trade = deps.evaluator(signal, simConfig, deps.allTradingDates, wfaEndDate);
        if (trade) {
          oosTrades.push(trade);
          openPositions.push(trade);
        }
      }

      const oosAnalytics = computeOptionAnalytics(oosTrades);
      const oosSharpe = oosAnalytics.dailyPortfolioSharpe ?? oosAnalytics.tradeSharpeLegacy;
      const oosMaxDD = oosAnalytics.dailyMtMDrawdownPct ?? oosAnalytics.realizedExitDrawdownPct;
      totalTrainSharpe += trainSharpe;

      windows.push({
        windowIndex: i,
        trainStart: w.trainStart,
        trainEnd: w.trainEnd,
        oosStart: w.oosStart,
        oosEnd: w.oosEnd,
        bestConfig: simConfig,
        bestTrainSharpe: trainSharpe,
        trainTradeCount: trainTrades.length,
        oosTrades,
        oosSharpe,
        oosWinRate: oosAnalytics.winRate,
        oosMaxDD,
        oosTradeCount: oosTrades.length,
      });

      allOOSTrades.push(...oosTrades);
    }

    const oosAllAnalytics = computeOptionAnalytics(allOOSTrades);
    const oosSharpe = oosAllAnalytics.dailyPortfolioSharpe ?? oosAllAnalytics.tradeSharpeLegacy;
    const oosMaxDD = oosAllAnalytics.dailyMtMDrawdownPct ?? oosAllAnalytics.realizedExitDrawdownPct;
    const avgTrainSharpe = windowDefs.length > 0 ? totalTrainSharpe / windowDefs.length : 0;

    const result: TrialAggResult = {
      trialId,
      params,
      windows,
      oosTrades: allOOSTrades,
      oosSharpe,
      oosWinRate: oosAllAnalytics.winRate,
      oosMaxDD,
      oosTotalPnl: allOOSTrades.reduce((s, t) => s + t.pnl, 0),
      avgTrainSharpe,
      wfEfficiency: avgTrainSharpe >= 0.1 ? oosSharpe / avgTrainSharpe : 0,
    };

    trialResults.push(result);
    return result;
  };

  // The runner script calls evaluateTrial externally — we return it
  // The orchestrator is designed to be driven by the runner

  // ── Phases 3-6 run after optimization completes ─────
  // These are called by finalizeResults()

  return {
    evaluateTrial,
    finalizeResults: () => finalize(config, deps, trialResults, holdoutStart),
  } as any;
}

/**
 * Finalize WFA v3 results after all trials are evaluated.
 * Runs phases 3-6: stats, holdout, regime, ranking.
 */
export function finalize(
  config: WFAv3Config,
  deps: V3OrchestratorDeps,
  trialResults: TrialAggResult[],
  holdoutStart: string,
): WFAv3Result {
  const t0 = Date.now();
  const log = deps.onProgress ?? (() => {});

  // Sort by composite fitness
  function computeFitness(r: TrialAggResult): number {
    const wfe = r.wfEfficiency > 0 ? Math.sqrt(r.wfEfficiency) : 0.5;
    const tradePenalty = Math.min(1, r.oosTrades.length / 200); // lower threshold for short DTE
    const ddPenalty = 1 / (1 + r.oosMaxDD / 10);
    return r.oosSharpe * wfe * tradePenalty * ddPenalty;
  }

  trialResults.sort((a, b) => computeFitness(b) - computeFitness(a));
  const bestTrial = trialResults[0];
  if (!bestTrial) throw new Error('No valid trials completed');

  log('optimize', `Best: Sharpe=${bestTrial.oosSharpe.toFixed(2)}, WR=${bestTrial.oosWinRate.toFixed(1)}%, DD=${bestTrial.oosMaxDD.toFixed(1)}%, WFE=${bestTrial.wfEfficiency.toFixed(3)}`);

  // ── Phase 3: Statistical Validation ─────────────────
  log('stats', 'Running statistical validation...');

  const oosReturns = bestTrial.oosTrades.map(t => t.pnlPct);
  const perWindowReturns = bestTrial.windows.map(w => w.oosTrades.map(t => t.pnlPct));

  const dsr = computeDSR(bestTrial.oosSharpe, trialResults.length, oosReturns);
  const pbo = computePBO(perWindowReturns, config.cscvBlocks, config.maxCscvCombinations);
  // Derive daily portfolio returns so the Sharpe CI uses the statistically
  // correct block bootstrap on daily returns (preserves autocorrelation).
  // See Codex finding T3-2 in .prompts/codex-trust-followups.md.
  // wfaEndDate = trading day immediately before holdoutStart.
  const holdoutIdx = deps.allTradingDates.indexOf(holdoutStart);
  const wfaEndDate = holdoutIdx > 0
    ? deps.allTradingDates[holdoutIdx - 1]
    : config.endDate;
  const oosDailyMetrics = computePortfolioDailyMetrics(
    bestTrial.oosTrades,
    deps.allTradingDates,
    bestTrial.windows[0]?.oosStart ?? config.startDate,
    wfaEndDate,
    config.startingCapital,
  );
  const bootstrap = blockBootstrap(
    bestTrial.oosTrades,
    config.bootstrapResamples,
    5,
    config.startingCapital,
    42,
    { dailyReturns: oosDailyMetrics.dailyReturns },
  );
  const permResult = permutationTest(bestTrial.oosTrades, 5000, config.startingCapital);

  const numericParams = [
    'creditShortDelta', 'creditSpreadWidth', 'creditProfitTarget',
    'creditStopLossMultiple', 'creditTimeStopDTE', 'minIVRank',
  ];
  const paramStability = computeParameterStability(bestTrial.windows, numericParams);
  const avgCV = paramStability.length > 0
    ? paramStability.reduce((s, p) => s + p.cv, 0) / paramStability.length : 0;
  const stability = Math.max(0, 1 - avgCV);

  const top20DSR = trialResults.slice(0, Math.min(20, trialResults.length)).map(t => {
    const r = t.oosTrades.map(tr => tr.pnlPct);
    return { configId: `trial_${t.trialId}`, pValue: 1 - computeDSR(t.oosSharpe, trialResults.length, r).dsr };
  });
  const bhCorrected = benjaminiHochberg(top20DSR);

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

  const bestConfig = v3ParamsToSimConfig(bestTrial.params);
  const periodMult = extractPeriodMultiplier(bestTrial.params);
  const presetKey = bestConfig.signalWeightPreset ?? 'ema';
  const allSignals = deps.signalsByMultPreset.get(signalMapKey(periodMult, presetKey)) ?? [];
  const holdoutSignals = allSignals.filter(s => s.date >= holdoutStart && s.date <= config.endDate);
  const maxPerTicker = (bestTrial.params.maxPerTicker as number) ?? 5;
  const maxPositions = (bestTrial.params.maxPositions as number) ?? 10;

  const holdoutTrades: OptionTrade[] = [];
  const holdoutOpen: OptionTrade[] = [];

  for (const signal of holdoutSignals) {
    for (let j = holdoutOpen.length - 1; j >= 0; j--) {
      if (holdoutOpen[j].exitDate <= signal.date) holdoutOpen.splice(j, 1);
    }
    if (holdoutOpen.length >= maxPositions) continue;
    if (holdoutOpen.filter(t => t.ticker === signal.ticker).length >= maxPerTicker) continue;

    const trade = deps.evaluator(signal, bestConfig, deps.allTradingDates, config.endDate);
    if (trade) {
      holdoutTrades.push(trade);
      holdoutOpen.push(trade);
    }
  }

  const holdoutAnalytics = computeOptionAnalytics(holdoutTrades);
  const holdoutSharpe = holdoutAnalytics.dailyPortfolioSharpe ?? holdoutAnalytics.tradeSharpeLegacy;
  const holdoutMaxDD = holdoutAnalytics.dailyMtMDrawdownPct ?? holdoutAnalytics.realizedExitDrawdownPct;
  const holdoutDegradation = bestTrial.oosSharpe > 0 ? holdoutSharpe / bestTrial.oosSharpe : 0;

  const holdout: HoldoutResult = {
    trades: holdoutTrades,
    sharpe: holdoutSharpe,
    winRate: holdoutAnalytics.winRate,
    maxDD: holdoutMaxDD,
    totalPnl: holdoutTrades.reduce((s, t) => s + t.pnl, 0),
    tradeCount: holdoutTrades.length,
    degradation: holdoutDegradation,
  };

  log('holdout', `Holdout: Sharpe=${holdout.sharpe.toFixed(2)}, degradation=${holdout.degradation.toFixed(2)}`);

  // ── Phase 5: Regime Analysis ────────────────────────
  log('regime', 'Running regime analysis...');

  const vixLookup = buildRegimeLookup(deps.vixData);
  const regimes = computeRegimeMetrics(bestTrial.oosTrades, vixLookup, config.startingCapital);

  // ── Phase 6: Ranking & Output ───────────────────────
  log('ranking', 'Computing composite ranking...');

  const evalResults: EvalResult[] = trialResults.slice(0, Math.min(50, trialResults.length)).map(t => {
    const r = t.oosTrades.map(tr => tr.pnlPct);
    const trialDSR = computeDSR(t.oosSharpe, trialResults.length, r);
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
    (a, b) => a.exitDate.localeCompare(b.exitDate),
  );
  let equity = config.startingCapital;
  const equityCurve: { date: string; equity: number }[] = [];
  for (const t of sortedTrades) {
    equity += t.pnl;
    equityCurve.push({ date: t.exitDate, equity });
  }

  const result: WFAv3Result = {
    oos: {
      windows: bestTrial.windows,
      allTrades: bestTrial.oosTrades,
      sharpe: bestTrial.oosSharpe,
      winRate: bestTrial.oosWinRate,
      maxDD: bestTrial.oosMaxDD,
      totalPnl: bestTrial.oosTotalPnl,
      wfEfficiency: bestTrial.wfEfficiency,
      equityCurve,
    },
    holdout,
    stats,
    regimes,
    bestConfig,
    ranking,
    paretoFrontier,
    dteProfile: 'short',
    totalEvaluations: trialResults.length,
    elapsedMs: Date.now() - t0,
    v3Meta: {
      intradayTimeframe: '4H',
      indicatorPeriodMultiplier: periodMult,
      bsmKappa: config.bsmKappa,
      bsmRiskFreeRate: config.bsmRiskFreeRate,
      ivThetaSource: config.ivThetaSource,
      dailyCalibration: config.dailyCalibration,
      intraday4HBars: 0,   // Set by runner
      signalSetsPrecomputed: 0, // Set by runner
    },
  };

  log('done', `Complete in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${trialResults.length} evaluations`);

  return result;
}

// ── Export for runner convenience ────────────────────────

export { v3ParamsToSimConfig, extractPeriodMultiplier } from './wfa-v3-optimizer';
export { DEFAULT_WFA_V3_CONFIG } from './wfa-v3-types';
