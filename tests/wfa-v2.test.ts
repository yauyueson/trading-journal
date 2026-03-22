/**
 * WFA v2 Tests — TPE optimizer, statistical validation, regime analysis, ranking
 */
import { describe, test, expect } from 'vitest';

// ── TPE Optimizer Tests ─────────────────────────────────

import { buildParameterSpace, runTPE, generateGrid, paramsToSimConfig } from '../src/lib/backtest/wfa-v2-optimizer';
import { DEFAULT_TPE_CONFIG, PROFILE_BOUNDS } from '../src/lib/backtest/wfa-v2-types';

describe('TPE Optimizer', () => {
  test('buildParameterSpace returns correct structure for swing profile', () => {
    const space = buildParameterSpace('swing');
    expect(space.continuous.length).toBeGreaterThan(5);
    expect(space.integer.length).toBeGreaterThanOrEqual(2);
    expect(space.categorical.length).toBeGreaterThanOrEqual(2);

    const deltaParam = space.continuous.find(p => p.name === 'creditShortDelta');
    expect(deltaParam).toBeDefined();
    expect(deltaParam!.low).toBe(PROFILE_BOUNDS.swing.creditShortDelta[0]);
    expect(deltaParam!.high).toBe(PROFILE_BOUNDS.swing.creditShortDelta[1]);
  });

  test('buildParameterSpace uses short profile bounds', () => {
    const space = buildParameterSpace('short');
    const widthParam = space.continuous.find(p => p.name === 'creditSpreadWidth');
    expect(widthParam!.low).toBe(PROFILE_BOUNDS.short.creditSpreadWidth[0]);
    expect(widthParam!.high).toBe(PROFILE_BOUNDS.short.creditSpreadWidth[1]);
  });

  test('TPE converges on simple 1D optimization', () => {
    // Optimize f(x) = -(x-3)^2 → max at x=3
    const space = {
      continuous: [{ name: 'x', low: 0, high: 6 }],
      integer: [],
      categorical: [],
    };

    const result = runTPE(
      space,
      (params) => -(Math.pow((params.x as number) - 3, 2)),
      { ...DEFAULT_TPE_CONFIG, nStartup: 10, nTotal: 50, seed: 42 },
    );

    expect(Math.abs((result.bestParams.x as number) - 3)).toBeLessThan(1.0);
    expect(result.allTrials.length).toBe(50);
    expect(result.bestObjective).toBeGreaterThan(-1);
  });

  test('TPE handles categorical parameters', () => {
    const space = {
      continuous: [{ name: 'x', low: 0, high: 10 }],
      integer: [],
      categorical: [{ name: 'color', choices: ['red', 'blue', 'green'] }],
    };

    const result = runTPE(
      space,
      (params) => {
        const x = params.x as number;
        const bonus = params.color === 'blue' ? 10 : 0;
        return -(Math.pow(x - 5, 2)) + bonus;
      },
      { ...DEFAULT_TPE_CONFIG, nStartup: 10, nTotal: 80, seed: 123 },
    );

    expect(result.bestParams.color).toBe('blue');
  });

  test('generateGrid produces factorial combinations', () => {
    const grid = generateGrid({
      creditShortDelta: [0.25, 0.35],
      signalWeightPreset: ['ema', 'mom'],
    }, 'swing');

    expect(grid.length).toBe(4); // 2 × 2
    expect(grid.every(c => 'creditShortDelta' in c && 'signalWeightPreset' in c)).toBe(true);
    // Should have defaults for missing params
    expect(grid[0].minIVRank).toBe(30);
  });

  test('paramsToSimConfig creates valid SimConfig', () => {
    const config = paramsToSimConfig({
      creditShortDelta: 0.30,
      creditSpreadWidth: 10,
      creditProfitTarget: 0.35,
      creditStopLossMultiple: 100,
      creditTimeStopDTE: 7,
      creditDeltaStop: 0,
      minIVRank: 30,
      maxPerTicker: 5,
      maxPositions: 10,
      signalWeightPreset: 'ema',
      useSmvVol: false,
      vrpFilter: 0,
      contangoFilter: 0,
      slopeFilter: 0,
      maxIVSkew: 0.15,
      monitoringIntervalDays: 1,
    }, 'swing');

    expect(config.mode).toBe('CREDIT_SPREAD');
    expect(config.creditShortDelta).toBe(0.30);
    expect(config.creditDTERange).toEqual([45, 65]);
    expect(config.fillMode).toBe('bidask');
    expect(config.slippage.enabled).toBe(true);
  });
});

// ── Statistical Validation Tests ────────────────────────

import { computeDSR, computePBO, blockBootstrap, permutationTest, benjaminiHochberg, computeParameterStability } from '../src/lib/backtest/wfa-v2-stats';
import type { OptionTrade } from '../src/lib/backtest/option-sim';
import type { WFAv2Window } from '../src/lib/backtest/wfa-v2-types';

function makeTrade(pnl: number, pnlPct: number, exitDate: string, holdDays: number = 14): OptionTrade {
  return {
    ticker: 'SPY', mode: 'CREDIT_SPREAD', direction: 'CALL',
    entryDate: '2024-01-01', entrySignalScore: 85,
    strike: 500, expiry: '2024-03-15', entryDTE: 45,
    entryPrice: 2.5, entryDelta: -0.27, entryIV: 0.20,
    entryStockPrice: 500,
    exitDate, exitPrice: 1.0, exitDTE: 7, exitStockPrice: 500,
    exitType: pnl > 0 ? 'PROFIT_TARGET' : 'EXPIRATION',
    pnl, pnlPct, holdDays,
  };
}

describe('Deflated Sharpe Ratio', () => {
  test('DSR expected max SR increases with more trials', () => {
    const returns = Array.from({ length: 100 }, (_, i) => 0.01 + Math.sin(i) * 0.02);
    const dsr10 = computeDSR(1.5, 10, returns);
    const dsr100 = computeDSR(1.5, 100, returns);
    const dsr1000 = computeDSR(1.5, 1000, returns);

    // More trials → expected max SR from noise increases
    expect(dsr1000.expectedMaxSR).toBeGreaterThan(dsr100.expectedMaxSR);
    expect(dsr100.expectedMaxSR).toBeGreaterThan(dsr10.expectedMaxSR);
    // DSR should be monotonically non-increasing (higher bar to clear)
    expect(dsr10.dsr).toBeGreaterThanOrEqual(dsr100.dsr);
    expect(dsr100.dsr).toBeGreaterThanOrEqual(dsr1000.dsr);
  });

  test('DSR is high for genuinely high SR with few trials', () => {
    const returns = Array.from({ length: 200 }, () => 0.02); // consistently positive
    const dsr = computeDSR(3.0, 5, returns);
    expect(dsr.dsr).toBeGreaterThan(0.9);
  });

  test('DSR handles edge cases', () => {
    const dsr = computeDSR(0, 1, []);
    expect(dsr.dsr).toBe(0.5); // no data → uninformative
  });
});

describe('PBO via CSCV', () => {
  test('PBO is low for consistently profitable returns', () => {
    // Generate 16 windows with positive returns
    const windows = Array.from({ length: 8 }, () =>
      Array.from({ length: 50 }, () => 0.01 + Math.random() * 0.02)
    );
    const pbo = computePBO(windows, 8, 100, 42);
    expect(pbo.pbo).toBeLessThan(0.5);
    expect(pbo.nCombinations).toBeGreaterThan(0);
  });

  test('PBO handles small datasets', () => {
    const pbo = computePBO([[0.01, 0.02]], 16, 100, 42);
    expect(pbo.pbo).toBe(0.5); // insufficient data
  });
});

describe('Block Bootstrap', () => {
  test('confidence intervals bracket the observed value', () => {
    const trades = Array.from({ length: 100 }, (_, i) =>
      makeTrade(i % 3 === 0 ? -50 : 100, i % 3 === 0 ? -0.05 : 0.03, `2024-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`)
    );

    const result = blockBootstrap(trades, 1000, 5, 100_000, 42);
    expect(result.nResamples).toBe(1000);
    expect(result.sharpe.ci5).toBeLessThanOrEqual(result.sharpe.ci50);
    expect(result.sharpe.ci50).toBeLessThanOrEqual(result.sharpe.ci95);
    expect(result.winRate.ci5).toBeGreaterThan(0);
  });

  test('handles small trade set', () => {
    const trades = [makeTrade(100, 0.05, '2024-01-15')];
    const result = blockBootstrap(trades, 100, 5, 100_000);
    expect(result.nResamples).toBe(0); // too few trades for block bootstrap
  });
});

describe('Permutation Test', () => {
  test('returns valid p-value', () => {
    const trades = Array.from({ length: 50 }, (_, i) =>
      makeTrade(i < 40 ? 100 : -200, i < 40 ? 0.03 : -0.06, `2024-01-${String((i % 28) + 1).padStart(2, '0')}`)
    );
    const result = permutationTest(trades, 500, 100_000, 42);
    expect(result.pValue).toBeGreaterThanOrEqual(0);
    expect(result.pValue).toBeLessThanOrEqual(1);
    expect(result.nullMean).toBeGreaterThan(0);
  });
});

describe('Benjamini-Hochberg', () => {
  test('corrects p-values and preserves order', () => {
    const pValues = [
      { configId: 'a', pValue: 0.01 },
      { configId: 'b', pValue: 0.04 },
      { configId: 'c', pValue: 0.10 },
      { configId: 'd', pValue: 0.50 },
    ];
    const result = benjaminiHochberg(pValues, 0.05);

    expect(result.length).toBe(4);
    // Adjusted p-values should be non-decreasing
    for (let i = 1; i < result.length; i++) {
      expect(result[i].adjustedPValue).toBeGreaterThanOrEqual(result[i - 1].adjustedPValue);
    }
    // First item (p=0.01) should be significant at FDR 0.05
    expect(result[0].significant).toBe(true);
  });

  test('empty input returns empty', () => {
    expect(benjaminiHochberg([])).toEqual([]);
  });
});

describe('Parameter Stability', () => {
  test('stable parameters have low CV', () => {
    const windows: WFAv2Window[] = [
      { windowIndex: 0, trainStart: '', trainEnd: '', oosStart: '', oosEnd: '',
        bestConfig: { creditShortDelta: 0.30, creditProfitTarget: 0.30 } as any,
        bestTrainSharpe: 1, trainTradeCount: 50, oosTrades: [], oosSharpe: 1, oosWinRate: 85, oosMaxDD: 5, oosTradeCount: 40 },
      { windowIndex: 1, trainStart: '', trainEnd: '', oosStart: '', oosEnd: '',
        bestConfig: { creditShortDelta: 0.31, creditProfitTarget: 0.30 } as any,
        bestTrainSharpe: 1.1, trainTradeCount: 55, oosTrades: [], oosSharpe: 1.1, oosWinRate: 87, oosMaxDD: 4, oosTradeCount: 45 },
      { windowIndex: 2, trainStart: '', trainEnd: '', oosStart: '', oosEnd: '',
        bestConfig: { creditShortDelta: 0.29, creditProfitTarget: 0.30 } as any,
        bestTrainSharpe: 0.9, trainTradeCount: 48, oosTrades: [], oosSharpe: 0.9, oosWinRate: 83, oosMaxDD: 6, oosTradeCount: 38 },
    ];

    const stability = computeParameterStability(windows, ['creditShortDelta', 'creditProfitTarget']);
    expect(stability.length).toBe(2);

    const deltaStab = stability.find(s => s.paramName === 'creditShortDelta')!;
    expect(deltaStab.isStable).toBe(true);
    expect(deltaStab.cv).toBeLessThan(0.10);

    const tpStab = stability.find(s => s.paramName === 'creditProfitTarget')!;
    expect(tpStab.cv).toBe(0); // identical values
    expect(tpStab.isStable).toBe(true);
  });
});

// ── Regime Analysis Tests ───────────────────────────────

import { classifyVIX, buildRegimeLookup, computeRegimeMetrics } from '../src/lib/backtest/wfa-v2-regime';

describe('Regime Analysis', () => {
  test('classifyVIX returns correct regime', () => {
    expect(classifyVIX(12)).toBe('low');
    expect(classifyVIX(19.9)).toBe('low');
    expect(classifyVIX(20)).toBe('mid');
    expect(classifyVIX(25)).toBe('mid');
    expect(classifyVIX(29.9)).toBe('mid');
    expect(classifyVIX(30)).toBe('high');
    expect(classifyVIX(80)).toBe('high');
  });

  test('buildRegimeLookup creates correct mapping', () => {
    const lookup = buildRegimeLookup([
      { date: '2024-01-02', close: 15 },
      { date: '2024-01-03', close: 25 },
      { date: '2024-01-04', close: 35 },
    ]);

    expect(lookup.size).toBe(3);
    expect(lookup.get('2024-01-02')!.regime).toBe('low');
    expect(lookup.get('2024-01-03')!.regime).toBe('mid');
    expect(lookup.get('2024-01-04')!.regime).toBe('high');
  });

  test('computeRegimeMetrics splits trades by regime', () => {
    const vixLookup = buildRegimeLookup([
      { date: '2024-01-02', close: 15 },
      { date: '2024-02-01', close: 25 },
      { date: '2024-03-01', close: 35 },
    ]);

    const trades: OptionTrade[] = [
      makeTrade(100, 0.05, '2024-01-15'), // low regime (entry 2024-01-01, but we use entry date lookup → closest is 2024-01-02)
      makeTrade(50, 0.03, '2024-02-15'),
      makeTrade(-100, -0.08, '2024-03-15'),
    ];
    // Patch entry dates to match VIX dates
    trades[0] = { ...trades[0], entryDate: '2024-01-02' };
    trades[1] = { ...trades[1], entryDate: '2024-02-01' };
    trades[2] = { ...trades[2], entryDate: '2024-03-01' };

    const metrics = computeRegimeMetrics(trades, vixLookup);
    expect(metrics.length).toBe(3);
    expect(metrics.find(m => m.regime === 'low')!.tradeCount).toBe(1);
    expect(metrics.find(m => m.regime === 'mid')!.tradeCount).toBe(1);
    expect(metrics.find(m => m.regime === 'high')!.tradeCount).toBe(1);
  });
});

// ── Ranking Tests ───────────────────────────────────────

import { computeCompositeRanking } from '../src/lib/backtest/wfa-v2-ranking';
import type { EvalResult } from '../src/lib/backtest/wfa-v2-ranking';

describe('Composite Ranking', () => {
  test('ranks by composite score — higher Sharpe + lower DD wins', () => {
    const results: EvalResult[] = [
      { configId: 'a', params: {}, sharpe: 2.0, maxDD: 5, wfe: 0.9, stability: 0.8, dsr: 0.95, winRate: 88, totalPnl: 50000, tradeCount: 100 },
      { configId: 'b', params: {}, sharpe: 1.5, maxDD: 3, wfe: 0.95, stability: 0.9, dsr: 0.90, winRate: 90, totalPnl: 40000, tradeCount: 100 },
      { configId: 'c', params: {}, sharpe: 0.5, maxDD: 15, wfe: 0.5, stability: 0.5, dsr: 0.5, winRate: 60, totalPnl: 5000, tradeCount: 50 },
    ];

    const ranked = computeCompositeRanking(results);
    expect(ranked.length).toBe(3);
    // Best composite should be a or b (high Sharpe + low DD)
    expect(['a', 'b']).toContain(ranked[0].configId);
    // Worst should be c
    expect(ranked[2].configId).toBe('c');
  });

  test('Pareto frontier identifies non-dominated configs', () => {
    const results: EvalResult[] = [
      { configId: 'a', params: {}, sharpe: 2.0, maxDD: 10, wfe: 0.8, stability: 0.8, dsr: 0.9, winRate: 85, totalPnl: 50000, tradeCount: 100 },
      { configId: 'b', params: {}, sharpe: 1.5, maxDD: 3, wfe: 0.9, stability: 0.8, dsr: 0.9, winRate: 90, totalPnl: 40000, tradeCount: 100 },
      { configId: 'c', params: {}, sharpe: 1.0, maxDD: 12, wfe: 0.5, stability: 0.5, dsr: 0.5, winRate: 70, totalPnl: 10000, tradeCount: 50 },
    ];

    const ranked = computeCompositeRanking(results);
    // a (best Sharpe) and b (best DD + WFE) should be Pareto-optimal
    // c is dominated by both
    const paretoIds = ranked.filter(r => r.isParetoOptimal).map(r => r.configId);
    expect(paretoIds).toContain('a');
    expect(paretoIds).toContain('b');
    expect(paretoIds).not.toContain('c');
  });

  test('empty input returns empty', () => {
    expect(computeCompositeRanking([])).toEqual([]);
  });
});

// ── Type & Integration Tests ────────────────────────────

describe('WFA v2 Types', () => {
  test('PROFILE_BOUNDS has both profiles', () => {
    expect(PROFILE_BOUNDS.swing.creditDTERange).toEqual([45, 65]);
    expect(PROFILE_BOUNDS.short.creditDTERange).toEqual([7, 21]);
  });

  test('swing spread width range is wider than short', () => {
    expect(PROFILE_BOUNDS.swing.creditSpreadWidth[1]).toBeGreaterThan(
      PROFILE_BOUNDS.short.creditSpreadWidth[1]
    );
  });
});
