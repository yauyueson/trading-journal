/**
 * WFA v3 Tests — Intraday cache, 4H signals, BSM monitoring, optimizer, integration
 */
import { describe, test, expect } from 'vitest';

// ── 1. Intraday Cache Tests ─────────────────────────────

import { aggregateToDaily } from '../src/lib/backtest/intraday-cache';
import type { IntradayCandle } from '../src/lib/backtest/intraday-cache';

describe('Intraday Cache', () => {
  const sample4H: IntradayCandle[] = [
    { ticker: 'SPY', timestamp: 1700000000000, datetime: '2024-01-02 09:30:00', date: '2024-01-02', open: 470, high: 472, low: 469, close: 471, volume: 1000000 },
    { ticker: 'SPY', timestamp: 1700014400000, datetime: '2024-01-02 13:30:00', date: '2024-01-02', open: 471, high: 474, low: 470, close: 473, volume: 1200000 },
    { ticker: 'SPY', timestamp: 1700086400000, datetime: '2024-01-03 09:30:00', date: '2024-01-03', open: 473, high: 475, low: 472, close: 474, volume: 900000 },
    { ticker: 'SPY', timestamp: 1700100800000, datetime: '2024-01-03 13:30:00', date: '2024-01-03', open: 474, high: 476, low: 473, close: 475, volume: 1100000 },
  ];

  test('aggregateToDaily groups by date and computes OHLCV correctly', () => {
    const daily = aggregateToDaily(sample4H);
    expect(daily).toHaveLength(2);

    // Day 1
    expect(daily[0].date).toBe('2024-01-02');
    expect(daily[0].open).toBe(470);      // first bar's open
    expect(daily[0].high).toBe(474);      // max high across bars
    expect(daily[0].low).toBe(469);       // min low across bars
    expect(daily[0].close).toBe(473);     // last bar's close
    expect(daily[0].volume).toBe(2200000); // sum of volumes

    // Day 2
    expect(daily[1].date).toBe('2024-01-03');
    expect(daily[1].open).toBe(473);
    expect(daily[1].close).toBe(475);
  });

  test('aggregateToDaily handles single bar per day', () => {
    const single: IntradayCandle[] = [
      { ticker: 'SPY', timestamp: 1700000000000, datetime: '2024-01-02 09:30:00', date: '2024-01-02', open: 470, high: 472, low: 469, close: 471, volume: 1000000 },
    ];
    const daily = aggregateToDaily(single);
    expect(daily).toHaveLength(1);
    expect(daily[0].open).toBe(470);
    expect(daily[0].close).toBe(471);
  });

  test('aggregateToDaily returns empty for empty input', () => {
    expect(aggregateToDaily([])).toHaveLength(0);
  });
});

// ── 2. Intraday Signal Tests ────────────────────────────

import { scaleIndicatorPeriods, PERIOD_MULTIPLIERS } from '../src/lib/backtest/intraday-signals';

describe('Intraday Signals', () => {
  test('scaleIndicatorPeriods multiplies all period params', () => {
    const scaled = scaleIndicatorPeriods(2.0);
    expect(scaled.sc_mb_len).toBe(200);    // 100 × 2.0
    expect(scaled.sc_osc_len).toBe(28);    // 14 × 2.0
    expect(scaled.sc_bx_s1).toBe(16);      // 8 × 2.0
    expect(scaled.sc_bx_s2).toBe(42);      // 21 × 2.0
    expect(scaled.sc_bx_l1).toBe(100);     // 50 × 2.0
    expect(scaled.sc_bx_l2).toBe(200);     // 100 × 2.0
  });

  test('scaleIndicatorPeriods with 1.5 multiplier rounds correctly', () => {
    const scaled = scaleIndicatorPeriods(1.5);
    expect(scaled.sc_mb_len).toBe(150);    // 100 × 1.5
    expect(scaled.sc_osc_len).toBe(21);    // round(14 × 1.5)
    expect(scaled.sc_bx_s1).toBe(12);      // round(8 × 1.5)
    expect(scaled.sc_bx_s2).toBe(32);      // round(21 × 1.5) = 31.5 → 32
  });

  test('scaleIndicatorPeriods with 3.0 multiplier', () => {
    const scaled = scaleIndicatorPeriods(3.0);
    expect(scaled.sc_mb_len).toBe(300);
    expect(scaled.sc_osc_len).toBe(42);
    expect(scaled.sc_bx_s1).toBe(24);
  });

  test('scaleIndicatorPeriods preserves non-period options', () => {
    const scaled = scaleIndicatorPeriods(2.0, { w_mb: 30, w_ema: 15 });
    expect(scaled.w_mb).toBe(30);
    expect(scaled.w_ema).toBe(15);
    expect(scaled.sc_mb_len).toBe(200);
  });

  test('PERIOD_MULTIPLIERS contains expected values', () => {
    expect(PERIOD_MULTIPLIERS).toEqual([1.5, 2.0, 2.5, 3.0]);
  });
});

// ── 3. BSM Repricing Tests ──────────────────────────────

import { bsmRepriceSpread, evaluateCreditSpread4H } from '../src/lib/backtest/intraday-monitor';

describe('BSM Repricing', () => {
  test('bsmRepriceSpread returns positive spread cost for put credit spread', () => {
    // Short put at $460 / long put at $450, stock at $470, 21 DTE
    const result = bsmRepriceSpread(
      460, 450,           // short/long strikes
      470,                // stock price
      0.25, 0.25,         // entry IV, HV theta
      4.0,                // kappa
      21,                 // entry DTE
      0,                  // 0 days elapsed (at entry)
      false,              // put spread
      0.04,               // risk-free rate
    );

    expect(result.spreadCost).toBeGreaterThan(0);
    expect(result.shortDelta).toBeLessThan(0); // put delta is negative
  });

  test('bsmRepriceSpread spread cost decreases as stock moves away from short strike', () => {
    const baseline = bsmRepriceSpread(460, 450, 470, 0.25, 0.25, 4.0, 21, 5, false, 0.04);
    const farAway = bsmRepriceSpread(460, 450, 490, 0.25, 0.25, 4.0, 21, 5, false, 0.04);

    // Stock at $490 (further OTM for short put) → less spread cost
    expect(farAway.spreadCost).toBeLessThan(baseline.spreadCost);
  });

  test('bsmRepriceSpread spread cost increases as stock approaches short strike', () => {
    const baseline = bsmRepriceSpread(460, 450, 470, 0.25, 0.25, 4.0, 21, 5, false, 0.04);
    const nearStrike = bsmRepriceSpread(460, 450, 462, 0.25, 0.25, 4.0, 21, 5, false, 0.04);

    // Stock at $462 (close to short put) → higher spread cost
    expect(nearStrike.spreadCost).toBeGreaterThan(baseline.spreadCost);
  });

  test('bsmRepriceSpread at expiration equals intrinsic value', () => {
    // At expiration (daysElapsed = entryDTE), should be intrinsic
    const itm = bsmRepriceSpread(460, 450, 455, 0.25, 0.25, 4.0, 21, 21, false, 0.04);
    // Short put $460 ITM by $5, long put $450 ITM by $5 → spread cost = 5-5 = 0?
    // Actually: short $460 put = max(0, 460-455) = 5, long $450 put = max(0, 450-455) = 0
    // spread cost = 5 - 0 = 5
    // But with BSM at T=0 it may differ slightly
    expect(itm.spreadCost).toBeCloseTo(5, 0);

    const otm = bsmRepriceSpread(460, 450, 480, 0.25, 0.25, 4.0, 21, 21, false, 0.04);
    // Both OTM: short put $460, stock at $480 → intrinsic 0
    expect(otm.spreadCost).toBeCloseTo(0, 0);
  });

  test('bsmRepriceSpread IV evolution via O-U affects pricing', () => {
    // Same scenario but with different kappa
    const fastRevert = bsmRepriceSpread(460, 450, 470, 0.40, 0.20, 8.0, 21, 10, false, 0.04);
    const slowRevert = bsmRepriceSpread(460, 450, 470, 0.40, 0.20, 1.0, 21, 10, false, 0.04);

    // Fast kappa = IV drops faster toward theta=0.20 → lower spread cost
    // Slow kappa = IV stays near 0.40 → higher spread cost
    expect(fastRevert.spreadCost).toBeLessThan(slowRevert.spreadCost);
  });

  test('evaluateCreditSpread4H exits earlier with 4H monitoring than end-of-day-only observation in a gamma spike', () => {
    const signal = {
      ticker: 'SPY',
      date: '2024-01-02',
      direction: 'CALL' as const,
      score: 82,
      hv60: 0.20,
    };
    const config = {
      mode: 'CREDIT_SPREAD' as const,
      leapDeltaRange: [0.65, 0.8] as [number, number],
      leapDTERange: [180, 365] as [number, number],
      leapProfitTarget: 0.5,
      leapStopLoss: 0.3,
      leapTimeStopDTE: 90,
      creditShortDelta: 0.30,
      creditSpreadWidth: 5,
      creditDTERange: [7, 14] as [number, number],
      creditProfitTarget: 0.99,
      creditStopLossMultiple: 100,
      creditTimeStopDTE: 1,
      monitoringIntervalDays: 1,
      minIVRank: 0,
      creditDeltaStop: 0.45,
      fillMode: 'mid' as const,
      slippage: { enabled: false, fillMode: 'bidask' as const, baseImpactBps: 2, oiHalfLife: 500, dteAccelDays: 7, dteAccelMultiplier: 3 },
      dailyCalibration: false,
      bsmKappa: 4.0,
      bsmRiskFreeRate: 0.04,
      ivThetaSource: 'hv60' as const,
    };

    const chainAccess = {
      getChain: () => [{ ok: true }],
      findSpread: () => ({
        short: {
          row: { strike: 460, expir_date: '2024-01-10', dte: 8, stock_price: 470 },
          type: 'Put',
          bid: 1.10,
          ask: 1.30,
          mid: 1.20,
          iv: 0.25,
          delta: -0.25,
          oi: 2000,
        },
        long: {
          row: { strike: 455, expir_date: '2024-01-10', dte: 8, stock_price: 470 },
          type: 'Put',
          bid: 0.60,
          ask: 0.80,
          mid: 0.70,
          iv: 0.24,
          delta: -0.15,
          oi: 1800,
        },
        netCredit: 0.50,
        requestedSpreadWidth: 5,
        spreadWidth: 5,
        maxLoss: 4.50,
      }),
      findContract: () => null,
      applyFillFn: () => ({ fillPrice: 0, slippage: 0 }),
    };

    const intradayCandles: IntradayCandle[] = [
      { ticker: 'SPY', timestamp: new Date('2024-01-03T10:00:00Z').getTime(), datetime: '2024-01-03 10:00:00', date: '2024-01-03', open: 470, high: 470, low: 455, close: 456, volume: 1_000_000 },
      { ticker: 'SPY', timestamp: new Date('2024-01-03T16:00:00Z').getTime(), datetime: '2024-01-03 16:00:00', date: '2024-01-03', open: 456, high: 470, low: 455, close: 469, volume: 900_000 },
      { ticker: 'SPY', timestamp: new Date('2024-01-04T16:00:00Z').getTime(), datetime: '2024-01-04 16:00:00', date: '2024-01-04', open: 469, high: 472, low: 468, close: 471, volume: 850_000 },
    ];
    const endOfDayOnly: IntradayCandle[] = [
      intradayCandles[1],
      intradayCandles[2],
    ];

    const intradayTrade = evaluateCreditSpread4H(
      signal,
      config,
      intradayCandles,
      ['2024-01-02', '2024-01-03', '2024-01-04'],
      '2024-01-04',
      chainAccess,
    );
    const endOfDayTrade = evaluateCreditSpread4H(
      signal,
      config,
      endOfDayOnly,
      ['2024-01-02', '2024-01-03', '2024-01-04'],
      '2024-01-04',
      chainAccess,
    );

    expect(intradayTrade).not.toBeNull();
    expect(endOfDayTrade).not.toBeNull();
    expect(intradayTrade!.exitType).toBe('DELTA_STOP');
    expect(endOfDayTrade!.exitDate > intradayTrade!.exitDate).toBe(true);
  });
});

// ── 4. v3 Optimizer Tests ───────────────────────────────

import { buildV3ParameterSpace, v3ParamsToSimConfig, extractPeriodMultiplier } from '../src/lib/backtest/wfa-v3-optimizer';

describe('v3 Optimizer', () => {
  test('buildV3ParameterSpace includes indicatorPeriodMultiplier', () => {
    const space = buildV3ParameterSpace();

    const periodMult = space.categorical.find(p => p.name === 'indicatorPeriodMultiplier');
    expect(periodMult).toBeDefined();
    expect(periodMult!.choices).toEqual(['1.5', '2', '2.5', '3']);
  });

  test('buildV3ParameterSpace has no monitoringIntervalDays', () => {
    const space = buildV3ParameterSpace();
    const monInterval = space.integer.find(p => p.name === 'monitoringIntervalDays');
    expect(monInterval).toBeUndefined();
  });

  test('buildV3ParameterSpace uses short DTE bounds', () => {
    const space = buildV3ParameterSpace();
    const delta = space.continuous.find(p => p.name === 'creditShortDelta');
    expect(delta!.low).toBe(0.10);
    expect(delta!.high).toBe(0.50);
  });

  test('v3ParamsToSimConfig produces valid SimConfig', () => {
    const params = {
      creditShortDelta: 0.30,
      creditSpreadWidth: 5,
      creditProfitTarget: 0.40,
      creditStopLossMultiple: 100,
      creditTimeStopDTE: 1,
      creditDeltaStop: 0,
      minIVRank: 30,
      vrpFilter: 0,
      contangoFilter: 0,
      slopeFilter: 0,
      maxIVSkew: 0.20,
      signalWeightPreset: 'ema',
      useSmvVol: false,
      indicatorPeriodMultiplier: 2.0,
    };

    const config = v3ParamsToSimConfig(params);
    expect(config.mode).toBe('CREDIT_SPREAD');
    expect(config.creditShortDelta).toBe(0.30);
    expect(config.creditSpreadWidth).toBe(5);
    expect(config.creditDTERange).toEqual([7, 21]);
    expect(config.creditProfitTarget).toBe(0.40);
    expect(config.minIVRank).toBe(30);
    expect(config.signalWeightPreset).toBe('ema');
    expect(config.fillMode).toBe('bidask');
    expect(config.slippage.enabled).toBe(true);
  });

  test('extractPeriodMultiplier returns correct value', () => {
    expect(extractPeriodMultiplier({ indicatorPeriodMultiplier: 1.5 })).toBe(1.5);
    expect(extractPeriodMultiplier({ indicatorPeriodMultiplier: 3.0 })).toBe(3.0);
    expect(extractPeriodMultiplier({})).toBe(2.0); // default
    expect(extractPeriodMultiplier({ indicatorPeriodMultiplier: 'invalid' })).toBe(2.0);
  });
});

// ── 5. v3 Types Tests ───────────────────────────────────

import { V3_PROFILE_BOUNDS, V3_SHORT_GRID, DEFAULT_WFA_V3_CONFIG } from '../src/lib/backtest/wfa-v3-types';
describe('v3 Types', () => {
  test('V3_PROFILE_BOUNDS has short DTE range', () => {
    expect(V3_PROFILE_BOUNDS.creditDTERange).toEqual([7, 21]);
    expect(V3_PROFILE_BOUNDS.creditShortDelta).toEqual([0.10, 0.50]);
    expect(V3_PROFILE_BOUNDS.creditTimeStopDTE).toEqual([1, 3]);
  });

  test('V3_SHORT_GRID includes indicatorPeriodMultiplier', () => {
    expect(V3_SHORT_GRID.indicatorPeriodMultiplier).toEqual([1.5, 2.0, 2.5, 3.0]);
    expect(V3_SHORT_GRID.signalWeightPreset).toContain('ema');
    expect(V3_SHORT_GRID.signalWeightPreset).toContain('mom');
  });

  test('DEFAULT_WFA_V3_CONFIG has shorter windows', () => {
    expect(DEFAULT_WFA_V3_CONFIG.trainWindowDays).toBe(252);
    expect(DEFAULT_WFA_V3_CONFIG.forwardStepDays).toBe(63);
    expect(DEFAULT_WFA_V3_CONFIG.purgeGapDays).toBe(21);
    expect(DEFAULT_WFA_V3_CONFIG.holdoutDays).toBe(63);
  });

  test('DEFAULT_WFA_V3_CONFIG has BSM parameters', () => {
    expect(DEFAULT_WFA_V3_CONFIG.bsmKappa).toBe(4.0);
    expect(DEFAULT_WFA_V3_CONFIG.bsmRiskFreeRate).toBe(0.04);
    expect(DEFAULT_WFA_V3_CONFIG.ivThetaSource).toBe('hv60');
    expect(DEFAULT_WFA_V3_CONFIG.dailyCalibration).toBe(true);
  });
});

// ── 6. Signal Map Key Tests ─────────────────────────────

import { signalMapKey } from '../src/lib/backtest/wfa-v3-orchestrator';

describe('v3 Orchestrator Helpers', () => {
  test('signalMapKey produces correct format', () => {
    expect(signalMapKey(2.0, 'ema')).toBe('2|ema');
    expect(signalMapKey(1.5, 'mom')).toBe('1.5|mom');
    expect(signalMapKey(3.0, 'full')).toBe('3|full');
  });
});
