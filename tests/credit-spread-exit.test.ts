import { describe, it, expect } from 'vitest';
import {
  resolveActualSpreadWidth,
  clampSpreadCloseCost,
  computeCreditSpreadThresholds,
  computeIntrinsicSpreadCloseCost,
  resolveTriggeredCreditExitCost,
  updateMissingChainState,
} from '../src/lib/backtest/credit-spread-exit';

// ── resolveActualSpreadWidth ──────────────────────────────────────────

describe('resolveActualSpreadWidth', () => {
  it('uses explicit spreadWidth when available', () => {
    const spread = { spreadWidth: 10, short: { row: { strike: 500 } }, long: { row: { strike: 490 } } };
    expect(resolveActualSpreadWidth(spread)).toBe(10);
  });

  it('computes from strikes when spreadWidth missing', () => {
    const spread = { short: { row: { strike: 500 } }, long: { row: { strike: 490 } } };
    expect(resolveActualSpreadWidth(spread)).toBe(10);
  });

  it('computes from strikes when spreadWidth is 0', () => {
    const spread = { spreadWidth: 0, short: { row: { strike: 500 } }, long: { row: { strike: 490 } } };
    expect(resolveActualSpreadWidth(spread)).toBe(10);
  });

  it('handles inverted strikes (call spread)', () => {
    const spread = { short: { row: { strike: 490 } }, long: { row: { strike: 500 } } };
    expect(resolveActualSpreadWidth(spread)).toBe(10);
  });
});

// ── clampSpreadCloseCost ──────────────────────────────────────────────

describe('clampSpreadCloseCost', () => {
  it('returns cost within bounds', () => {
    expect(clampSpreadCloseCost(5, 10)).toBe(5);
  });

  it('clamps negative cost to 0', () => {
    expect(clampSpreadCloseCost(-2, 10)).toBe(0);
  });

  it('clamps cost exceeding width to width', () => {
    expect(clampSpreadCloseCost(15, 10)).toBe(10);
  });

  it('handles NaN by returning width', () => {
    expect(clampSpreadCloseCost(NaN, 10)).toBe(10);
  });

  it('handles Infinity by returning width', () => {
    expect(clampSpreadCloseCost(Infinity, 10)).toBe(10);
  });

  it('handles zero width', () => {
    expect(clampSpreadCloseCost(5, 0)).toBe(0);
  });
});

// ── computeCreditSpreadThresholds ─────────────────────────────────────

describe('computeCreditSpreadThresholds', () => {
  const spread = { spreadWidth: 10, short: { row: { strike: 500 } }, long: { row: { strike: 490 } } };

  it('DTE5 champion config: SL 2.5x, TP hold-to-expiry', () => {
    const config = { creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, creditMaxLossStopPct: undefined };
    const t = computeCreditSpreadThresholds(config, spread, 0.50);

    expect(t.actualWidth).toBe(10);
    expect(t.boundedEntryCredit).toBe(0.50);
    expect(t.maxLoss).toBe(9.50);
    expect(t.tpProfit).toBe(0.50);
    expect(t.tpCost).toBe(0);          // hold-to-expiry: cost drops to 0
    expect(t.slCost).toBe(1.25);       // 2.5 * 0.50
    expect(t.maxLossStopCost).toBe(Infinity); // disabled
  });

  it('50% profit target', () => {
    const config = { creditProfitTarget: 0.5, creditStopLossMultiple: 1.5, creditMaxLossStopPct: undefined };
    const t = computeCreditSpreadThresholds(config, spread, 0.50);

    expect(t.tpProfit).toBe(0.25);     // 50% of 0.50
    expect(t.tpCost).toBe(0.25);       // 0.50 - 0.25
    expect(t.slCost).toBe(0.75);       // 1.5 * 0.50
  });

  it('max loss stop at 80%', () => {
    const config = { creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, creditMaxLossStopPct: 0.8 };
    const t = computeCreditSpreadThresholds(config, spread, 0.50);

    // maxLossStopCost = credit + 80% * maxLoss = 0.50 + 0.80 * 9.50 = 8.10
    expect(t.maxLossStopCost).toBeCloseTo(8.10, 2);
  });

  it('entry credit exceeding width is clamped', () => {
    const config = { creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, creditMaxLossStopPct: undefined };
    const t = computeCreditSpreadThresholds(config, spread, 15);

    expect(t.boundedEntryCredit).toBe(10); // clamped to width
    expect(t.maxLoss).toBe(0);             // width - credit = 0
  });

  it('zero entry credit', () => {
    const config = { creditProfitTarget: 1.0, creditStopLossMultiple: 2.5, creditMaxLossStopPct: undefined };
    const t = computeCreditSpreadThresholds(config, spread, 0);

    expect(t.boundedEntryCredit).toBe(0);
    expect(t.maxLoss).toBe(10);
    expect(t.tpProfit).toBe(0);
    expect(t.slCost).toBe(0);
  });
});

// ── computeIntrinsicSpreadCloseCost ───────────────────────────────────

describe('computeIntrinsicSpreadCloseCost', () => {
  // Bull put spread: short 500, long 490, width $10

  it('put spread: stock above both strikes (OTM — full profit)', () => {
    // Both intrinsics = 0, cost = 0
    expect(computeIntrinsicSpreadCloseCost('Put', 500, 490, 510, 10)).toBe(0);
  });

  it('put spread: stock between strikes (partial loss)', () => {
    // short intrinsic = max(0, 500-495) = 5, long intrinsic = max(0, 490-495) = 0
    // cost = 5 - 0 = 5
    expect(computeIntrinsicSpreadCloseCost('Put', 500, 490, 495, 10)).toBe(5);
  });

  it('put spread: stock below both strikes (max loss)', () => {
    // short intrinsic = max(0, 500-480) = 20, long intrinsic = max(0, 490-480) = 10
    // cost = 20 - 10 = 10, clamped to width = 10
    expect(computeIntrinsicSpreadCloseCost('Put', 500, 490, 480, 10)).toBe(10);
  });

  it('put spread: stock well below (clamped to width)', () => {
    // short intrinsic = 100, long intrinsic = 90, raw = 10, clamped to 10
    expect(computeIntrinsicSpreadCloseCost('Put', 500, 490, 400, 10)).toBe(10);
  });

  it('call spread: stock above both strikes (max loss for bear call)', () => {
    // Bear call: short 500, long 510, width 10
    // short intrinsic = max(0, 520-500) = 20, long intrinsic = max(0, 520-510) = 10
    // cost = 20 - 10 = 10, clamped to 10
    expect(computeIntrinsicSpreadCloseCost('Call', 500, 510, 520, 10)).toBe(10);
  });

  it('call spread: stock below both strikes (OTM — full profit)', () => {
    expect(computeIntrinsicSpreadCloseCost('Call', 500, 510, 490, 10)).toBe(0);
  });
});

// ── resolveTriggeredCreditExitCost ────────────────────────────────────

describe('resolveTriggeredCreditExitCost', () => {
  const thresholds = {
    actualWidth: 10,
    boundedEntryCredit: 0.50,
    maxLoss: 9.50,
    tpCost: 0,
    slCost: 1.25,
    maxLossStopCost: Infinity,
    tpProfit: 0.50,
  };

  it('PROFIT_TARGET returns tpCost', () => {
    expect(resolveTriggeredCreditExitCost('PROFIT_TARGET', 0.10, thresholds)).toBe(0);
  });

  it('STOP_LOSS returns slCost', () => {
    expect(resolveTriggeredCreditExitCost('STOP_LOSS', 1.50, thresholds)).toBe(1.25);
  });

  it('MAX_LOSS_STOP returns maxLossStopCost', () => {
    expect(resolveTriggeredCreditExitCost('MAX_LOSS_STOP', 9.0, thresholds)).toBe(Infinity);
  });

  it('TRAILING_LOCK returns market cost, not floor (conservative fill)', () => {
    // The floor is the trigger level, not the fill level. Once the market
    // has moved past the floor, a resting limit at the floor cannot fill.
    // Same principle as STOP_LOSS — exit at whatever the market offers.
    expect(resolveTriggeredCreditExitCost('TRAILING_LOCK', 0.30, thresholds, { trailingFloorCost: 0.25 })).toBe(0.30);
  });

  it('TRAILING_LOCK ignores trailingFloorCost option', () => {
    expect(resolveTriggeredCreditExitCost('TRAILING_LOCK', 0.30, thresholds)).toBe(0.30);
  });

  it('EXPIRATION returns clamped current cost', () => {
    expect(resolveTriggeredCreditExitCost('EXPIRATION', 0.10, thresholds)).toBe(0.10);
  });

  it('TIME_STOP returns clamped current cost', () => {
    expect(resolveTriggeredCreditExitCost('TIME_STOP', 0.80, thresholds)).toBe(0.80);
  });

  it('DELTA_STOP returns clamped current cost', () => {
    expect(resolveTriggeredCreditExitCost('DELTA_STOP', 0.60, thresholds)).toBe(0.60);
  });

  it('clamps negative cost to 0', () => {
    expect(resolveTriggeredCreditExitCost('EXPIRATION', -1, thresholds)).toBe(0);
  });

  it('clamps cost exceeding width', () => {
    expect(resolveTriggeredCreditExitCost('EXPIRATION', 15, thresholds)).toBe(10);
  });
});

// ── updateMissingChainState ───────────────────────────────────────────

describe('updateMissingChainState', () => {
  const initial = { consecutiveMissingDays: 0, totalMonitoringDays: 0, missingMonitoringDays: 0 };

  it('increments on missing data', () => {
    const s = updateMissingChainState(initial, false);
    expect(s.consecutiveMissingDays).toBe(1);
    expect(s.totalMonitoringDays).toBe(1);
    expect(s.missingMonitoringDays).toBe(1);
  });

  it('resets consecutive on valid data', () => {
    const s1 = updateMissingChainState(initial, false);
    const s2 = updateMissingChainState(s1, true);
    expect(s2.consecutiveMissingDays).toBe(0);
    expect(s2.totalMonitoringDays).toBe(2);
    expect(s2.missingMonitoringDays).toBe(1);
  });

  it('accumulates consecutive missing', () => {
    let s = initial;
    s = updateMissingChainState(s, false);
    s = updateMissingChainState(s, false);
    s = updateMissingChainState(s, false);
    expect(s.consecutiveMissingDays).toBe(3);
    expect(s.totalMonitoringDays).toBe(3);
    expect(s.missingMonitoringDays).toBe(3);
  });
});
