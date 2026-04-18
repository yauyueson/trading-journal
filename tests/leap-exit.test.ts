import { describe, it, expect } from 'vitest';
import {
  checkLeapExitType,
  computeIntrinsicValue,
  computeLeapEntryPrice,
  computeLeapExitPrice,
  computeLeapThresholds,
  createLeapMissingChainState,
  createLeapTrailState,
  incrementLeapMissingChain,
  resetLeapMissingChain,
  shouldExitOnSignalInvalidation,
  updateLeapTrailState,
} from '../src/lib/backtest/leap-exit';
import { DEFAULT_LEAP_CONFIG } from '../src/lib/backtest/option-sim';
import type { EntrySignal, SimConfig } from '../src/lib/backtest/option-sim';
import type { StrikeMatch } from '../src/lib/backtest/chain-cache';

function mkEntry(overrides: Partial<StrikeMatch & { row: Partial<StrikeMatch['row']> }> = {}): StrikeMatch {
  return {
    row: {
      ticker: 'AAPL',
      quote_date: '2024-01-02',
      strike: 150,
      expir_date: '2024-10-18',
      type: 'Call' as const,
      dte: 290,
      bid: 50,
      ask: 52,
      mid: 51,
      iv: 0.22,
      delta: 0.72,
      gamma: 0.01,
      theta: -0.05,
      vega: 0.5,
      oi: 5000,
      volume: 300,
      stock_price: 200,
      ...(overrides.row || {}),
    },
    delta: overrides.delta ?? 0.72,
    iv: overrides.iv ?? 0.22,
    mid: overrides.mid ?? 51,
    bid: overrides.bid ?? 50,
    ask: overrides.ask ?? 52,
    oi: overrides.oi ?? 5000,
  } as StrikeMatch;
}

function mkSignal(overrides: Partial<EntrySignal> = {}): EntrySignal {
  return {
    ticker: 'AAPL',
    date: '2024-01-02',
    direction: 'CALL',
    score: 100,
    ...overrides,
  } as EntrySignal;
}

describe('leap-exit — fill pricing', () => {
  it('computeLeapEntryPrice applies dynamic slippage when enabled', () => {
    const entry = mkEntry();
    const { entryPrice, entrySlippage } = computeLeapEntryPrice(entry, DEFAULT_LEAP_CONFIG);
    expect(entryPrice).toBeGreaterThan(entry.mid);
    expect(entrySlippage).toBeGreaterThanOrEqual(0);
  });

  it('computeLeapEntryPrice returns mid when fillMode is "mid"', () => {
    const entry = mkEntry();
    const cfg = { ...DEFAULT_LEAP_CONFIG, fillMode: 'mid' as const };
    const { entryPrice, entrySlippage } = computeLeapEntryPrice(entry, cfg);
    expect(entryPrice).toBe(entry.mid);
    expect(entrySlippage).toBe(0);
  });

  it('computeLeapExitPrice applies slippage on sell side (fill below mid)', () => {
    const current = mkEntry();
    const { exitPrice, exitSlippage, currentMid } = computeLeapExitPrice(current, DEFAULT_LEAP_CONFIG);
    expect(exitPrice).toBeLessThan(current.mid);
    expect(exitSlippage).toBeGreaterThanOrEqual(0);
    expect(currentMid).toBe(current.mid);
  });
});

describe('leap-exit — thresholds + exit detection', () => {
  it('computeLeapThresholds derives TP, SL, and trail params from entry', () => {
    const cfg: SimConfig = { ...DEFAULT_LEAP_CONFIG, leapProfitTarget: 0.4, leapStopLoss: 0.3 };
    const t = computeLeapThresholds(100, cfg);
    expect(t.entryPrice).toBe(100);
    expect(t.tpPrice).toBe(140);
    expect(t.slPrice).toBe(70);
    expect(t.trailActivatePrice).toBeNull(); // default config has no trailingActivatePct
  });

  it('computeLeapThresholds activates trail pricing when config sets trail params', () => {
    const cfg: SimConfig = {
      ...DEFAULT_LEAP_CONFIG,
      leapProfitTarget: 0.5,
      trailingActivatePct: 0.5,
      trailingFloorPct: 0.25,
    };
    const t = computeLeapThresholds(100, cfg);
    // activate = 100 + 100 * 0.5 * 0.5 = 125
    expect(t.trailActivatePrice).toBe(125);
    expect(t.trailFloorPct).toBe(0.25);
  });

  it('checkLeapExitType priority: TRAILING_LOCK > TP > SL > SIGNAL_REVERSAL > TIME_STOP', () => {
    const cfg: SimConfig = {
      ...DEFAULT_LEAP_CONFIG,
      leapProfitTarget: 0.4,
      leapStopLoss: 0.3,
      leapTimeStopDTE: 90,
    };
    const thresholds = computeLeapThresholds(100, cfg);
    const signal = mkSignal();

    // No exit when inside bands
    expect(checkLeapExitType(120, thresholds, 200, createLeapTrailState(), signal, cfg, '2024-06-01')).toBeNull();
    // TP
    expect(checkLeapExitType(140, thresholds, 200, createLeapTrailState(), signal, cfg, '2024-06-01')).toBe('PROFIT_TARGET');
    // SL
    expect(checkLeapExitType(70, thresholds, 200, createLeapTrailState(), signal, cfg, '2024-06-01')).toBe('STOP_LOSS');
    // Time stop
    expect(checkLeapExitType(110, thresholds, 89, createLeapTrailState(), signal, cfg, '2024-06-01')).toBe('TIME_STOP');

    // Trailing lock beats TP
    const trail = { active: true, peak: 140, floor: 130 };
    expect(checkLeapExitType(125, thresholds, 200, trail, signal, cfg, '2024-06-01')).toBe('TRAILING_LOCK');
  });
});

describe('leap-exit — trailing lock state', () => {
  it('activates when price hits activation threshold', () => {
    const cfg: SimConfig = {
      ...DEFAULT_LEAP_CONFIG,
      leapProfitTarget: 0.4,
      trailingActivatePct: 0.5,
      trailingFloorPct: 0.25,
    };
    const t = computeLeapThresholds(100, cfg);
    let trail = createLeapTrailState();
    expect(trail.active).toBe(false);
    // below activate (120 < 120? activate = 100+100*0.4*0.5=120) → nothing; try 120 exactly
    trail = updateLeapTrailState(trail, 120, t);
    expect(trail.active).toBe(true);
    expect(trail.peak).toBe(120);
    expect(trail.floor).toBe(120 * (1 - 0.25));
  });

  it('tracks new peaks and raises floor after activation', () => {
    const cfg: SimConfig = {
      ...DEFAULT_LEAP_CONFIG,
      leapProfitTarget: 0.5,
      trailingActivatePct: 0.5,
      trailingFloorPct: 0.25,
    };
    const t = computeLeapThresholds(100, cfg);
    let trail = createLeapTrailState();
    trail = updateLeapTrailState(trail, 125, t); // activate at 125
    trail = updateLeapTrailState(trail, 140, t); // new peak
    expect(trail.peak).toBe(140);
    expect(trail.floor).toBe(140 * (1 - 0.25));
    trail = updateLeapTrailState(trail, 135, t); // no new peak, floor unchanged
    expect(trail.peak).toBe(140);
  });

  it('does nothing when trail pricing is disabled', () => {
    const cfg: SimConfig = { ...DEFAULT_LEAP_CONFIG };
    const t = computeLeapThresholds(100, cfg);
    let trail = createLeapTrailState();
    trail = updateLeapTrailState(trail, 200, t);
    expect(trail.active).toBe(false);
  });
});

describe('leap-exit — missing-chain state', () => {
  it('increments streak and flags forceExitNow at threshold', () => {
    const cfg: SimConfig = { ...DEFAULT_LEAP_CONFIG, missingChainExitAfterDays: 3 };
    let state = createLeapMissingChainState();
    let step = incrementLeapMissingChain(state, cfg);
    state = step.state;
    expect(state.streak).toBe(1);
    expect(step.forceExitNow).toBe(false);

    step = incrementLeapMissingChain(state, cfg);
    state = step.state;
    expect(step.forceExitNow).toBe(false); // streak 2

    step = incrementLeapMissingChain(state, cfg);
    state = step.state;
    expect(state.streak).toBe(3);
    expect(step.forceExitNow).toBe(true);
  });

  it('resetLeapMissingChain records last-known exit price and zeros streak', () => {
    const reset = resetLeapMissingChain(45.5);
    expect(reset.streak).toBe(0);
    expect(reset.lastKnownExitPrice).toBe(45.5);
  });

  it('never forces exit when missingChainExitAfterDays is unset', () => {
    const cfg: SimConfig = { ...DEFAULT_LEAP_CONFIG, missingChainExitAfterDays: undefined };
    let state = createLeapMissingChainState();
    for (let i = 0; i < 10; i++) {
      const step = incrementLeapMissingChain(state, cfg);
      state = step.state;
      expect(step.forceExitNow).toBe(false);
    }
  });
});

describe('leap-exit — signal invalidation', () => {
  it('returns false when config.signalInvalidation is unset', () => {
    const cfg: SimConfig = { ...DEFAULT_LEAP_CONFIG };
    const signal = mkSignal({ invalidation: { macroBreakDate: '2024-03-01' } });
    expect(shouldExitOnSignalInvalidation('2024-06-01', signal, cfg)).toBe(false);
  });

  it('fires at grace=0 as soon as macroBreakDate is reached', () => {
    const cfg: SimConfig = { ...DEFAULT_LEAP_CONFIG, signalInvalidation: { type: 'macro', graceDays: 0 } };
    const signal = mkSignal({ invalidation: { macroBreakDate: '2024-03-01' } });
    expect(shouldExitOnSignalInvalidation('2024-02-29', signal, cfg)).toBe(false);
    expect(shouldExitOnSignalInvalidation('2024-03-01', signal, cfg)).toBe(true);
  });

  it('uses 3d-confirmed dates when graceDays >= 3', () => {
    const cfg: SimConfig = { ...DEFAULT_LEAP_CONFIG, signalInvalidation: { type: 'macro', graceDays: 3 } };
    const signal = mkSignal({ invalidation: { macroBreakDate: '2024-03-01', macro3dBreakDate: '2024-03-04' } });
    expect(shouldExitOnSignalInvalidation('2024-03-01', signal, cfg)).toBe(false);
    expect(shouldExitOnSignalInvalidation('2024-03-04', signal, cfg)).toBe(true);
  });

  it('"any" picks the earliest break across all 3 dimensions', () => {
    const cfg: SimConfig = { ...DEFAULT_LEAP_CONFIG, signalInvalidation: { type: 'any', graceDays: 0 } };
    const signal = mkSignal({
      invalidation: {
        macroBreakDate: '2024-05-01',
        trendBreakDate: '2024-03-15',
        momentumBreakDate: '2024-04-01',
      },
    });
    // Earliest = trendBreakDate 2024-03-15
    expect(shouldExitOnSignalInvalidation('2024-03-14', signal, cfg)).toBe(false);
    expect(shouldExitOnSignalInvalidation('2024-03-15', signal, cfg)).toBe(true);
  });
});

describe('leap-exit — intrinsic value fallback', () => {
  it('Call: max(0, stock - strike)', () => {
    expect(computeIntrinsicValue(100, 90, 'Call')).toBe(10);
    expect(computeIntrinsicValue(80, 90, 'Call')).toBe(0);
  });
  it('Put: max(0, strike - stock)', () => {
    expect(computeIntrinsicValue(80, 90, 'Put')).toBe(10);
    expect(computeIntrinsicValue(100, 90, 'Put')).toBe(0);
  });
});
