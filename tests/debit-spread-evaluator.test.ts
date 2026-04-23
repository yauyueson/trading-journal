/**
 * Phase F0 prep — unit tests for makeDebitSpreadEvaluator.
 *
 * Codex adversarial review (2026-04-22) flagged three reliability gaps
 * prior to the Phase F0 clean-slate restart:
 *   - same-expiry retry never reassigned shortMatch (dead code path)
 *   - debitMaxHoldDays config field declared but not enforced
 *   - missing-chain days silently continued with no force-close protection
 *
 * This suite locks in the fixes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { EntrySignal, SimConfig } from '../src/lib/backtest/option-sim';
import { DEFAULT_LEAP_CONFIG } from '../src/lib/backtest/option-sim';
import { makeDebitSpreadEvaluator } from '../scripts/autoresearch/worker';

interface ChainRowLike {
  ticker: string; trade_date: string; expir_date: string; dte: number;
  strike: number; stock_price: number;
  call_bid: number; call_mid: number; call_ask: number;
  call_iv: number; call_volume: number; call_oi: number;
  put_bid: number; put_mid: number; put_ask: number;
  put_iv: number; put_volume: number; put_oi: number;
  delta: number; gamma: number; theta: number; vega: number;
}

function makeRow(opts: {
  ticker: string; date: string; expiry: string; dte: number;
  strike: number; spot: number;
  callBid: number; callMid: number; callAsk: number;
  delta: number; oi?: number;
}): ChainRowLike {
  return {
    ticker: opts.ticker, trade_date: opts.date, expir_date: opts.expiry, dte: opts.dte,
    strike: opts.strike, stock_price: opts.spot,
    call_bid: opts.callBid, call_mid: opts.callMid, call_ask: opts.callAsk,
    call_iv: 0.20, call_volume: 500, call_oi: opts.oi ?? 2000,
    put_bid: 0, put_mid: 0, put_ask: 0, put_iv: 0.20, put_volume: 0, put_oi: 0,
    delta: opts.delta, gamma: 0.005, theta: -0.03, vega: 0.15,
  };
}

const mockChainByDate = new Map<string, ChainRowLike[]>();

vi.mock('../src/lib/backtest/chain-cache', () => ({
  fetchHistoricalChain: vi.fn(async (_t: string, _k: string, date: string) => mockChainByDate.get(date) ?? []),
  getCachedChain: vi.fn((_ticker: string, date: string) => mockChainByDate.get(date) ?? []),
  getCachedChainFiltered: vi.fn((_ticker: string, date: string, _expFilter: unknown, dteRange: [number, number]) => {
    const chain = mockChainByDate.get(date) ?? [];
    return chain.filter((r: ChainRowLike) => r.dte >= dteRange[0] && r.dte <= dteRange[1]);
  }),
  findStrikeByDelta: vi.fn((chain: ChainRowLike[], targetDelta: number, type: 'Call' | 'Put', dteRange: [number, number]) => {
    const filtered = chain.filter(r => r.dte >= dteRange[0] && r.dte <= dteRange[1]);
    if (filtered.length === 0) return null;
    const picked = filtered.reduce((best, r) =>
      Math.abs((r.delta ?? 0) - targetDelta) < Math.abs((best.delta ?? 0) - targetDelta) ? r : best);
    return {
      row: picked,
      bid: type === 'Call' ? picked.call_bid : picked.put_bid,
      mid: type === 'Call' ? picked.call_mid : picked.put_mid,
      ask: type === 'Call' ? picked.call_ask : picked.put_ask,
      iv: type === 'Call' ? picked.call_iv : picked.put_iv,
      delta: picked.delta,
      volume: type === 'Call' ? picked.call_volume : picked.put_volume,
      oi: type === 'Call' ? picked.call_oi : picked.put_oi,
    };
  }),
  findContract: vi.fn((chain: ChainRowLike[], strike: number, expiry: string, _type: 'Call' | 'Put') => {
    const picked = chain.find(r => r.strike === strike && r.expir_date === expiry);
    if (!picked) return null;
    return { row: picked, bid: picked.call_bid, mid: picked.call_mid, ask: picked.call_ask,
             iv: picked.call_iv, delta: picked.delta, volume: picked.call_volume, oi: picked.call_oi };
  }),
  findContractDirect: vi.fn((_ticker: string, date: string, strike: number, expiry: string, _type: 'Call' | 'Put') => {
    const chain = mockChainByDate.get(date) ?? [];
    const picked = chain.find(r => r.strike === strike && r.expir_date === expiry);
    if (!picked) return null;
    return { row: picked, bid: picked.call_bid, mid: picked.call_mid, ask: picked.call_ask,
             iv: picked.call_iv, delta: picked.delta, volume: picked.call_volume, oi: picked.call_oi };
  }),
  findSpreadStrikes: vi.fn(() => null),
  initDB: vi.fn(),
  closeDB: vi.fn(),
}));

function buildWeekdays(startStr: string, endStr: string): string[] {
  const out: string[] = [];
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay(); if (wd === 0 || wd === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const BASE_CONFIG: SimConfig = {
  ...DEFAULT_LEAP_CONFIG,
  mode: 'DEBIT_SPREAD',
  debitDTERange: [30, 60],
  debitLongDelta: 0.50,
  debitShortDelta: 0.20,
  debitProfitTargetPct: 0.50,
  debitMaxHoldDays: 45,
  debitMinExitDTE: 7,
  monitoringIntervalDays: 1,
  fillMode: 'mid',  // deterministic arithmetic for test assertions
};

describe('makeDebitSpreadEvaluator — happy path', () => {
  beforeEach(() => mockChainByDate.clear());

  it('opens bull call debit, closes at profit target', () => {
    // Entry 2026-01-05. Long call delta 0.50 strike 400, short 0.20 strike 420, expiry 2026-02-20 (46 DTE).
    // Entry debit = long_mid 10 - short_mid 2 = 8. Max profit = width 20 - debit 8 = 12.
    // Profit target 50% of max profit = $6. Hits when (cur_spread_mid - 8) >= 6, i.e., spread ≥ 14.
    mockChainByDate.set('2026-01-05', [
      makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-02-20', dte: 46, strike: 400, spot: 400, callBid: 9.9, callMid: 10, callAsk: 10.1, delta: 0.50 }),
      makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-02-20', dte: 46, strike: 420, spot: 400, callBid: 1.9, callMid: 2, callAsk: 2.1, delta: 0.20 }),
    ]);
    // Fill intermediate days so missing-chain guard doesn't trigger before profit target.
    // Days 06-14: spread static at 8 (no profit yet).
    for (const d of buildWeekdays('2026-01-06', '2026-01-14')) {
      const dte = 46 - buildWeekdays('2026-01-05', d).length + 1;
      mockChainByDate.set(d, [
        makeRow({ ticker: 'QQQ', date: d, expiry: '2026-02-20', dte, strike: 400, spot: 400, callBid: 10, callMid: 10, callAsk: 10, delta: 0.50 }),
        makeRow({ ticker: 'QQQ', date: d, expiry: '2026-02-20', dte, strike: 420, spot: 400, callBid: 2, callMid: 2, callAsk: 2, delta: 0.20 }),
      ]);
    }
    // Day 15: spread hits 14 → profit target.
    mockChainByDate.set('2026-01-15', [
      makeRow({ ticker: 'QQQ', date: '2026-01-15', expiry: '2026-02-20', dte: 36, strike: 400, spot: 410, callBid: 16, callMid: 16, callAsk: 16, delta: 0.65 }),
      makeRow({ ticker: 'QQQ', date: '2026-01-15', expiry: '2026-02-20', dte: 36, strike: 420, spot: 410, callBid: 2, callMid: 2, callAsk: 2, delta: 0.25 }),
    ]);

    const evaluator = makeDebitSpreadEvaluator(BASE_CONFIG);
    const signal: EntrySignal = { ticker: 'QQQ', date: '2026-01-05', direction: 'CALL', score: 0 };
    const allDates = buildWeekdays('2026-01-05', '2026-02-20');

    const trade = evaluator(signal, BASE_CONFIG, allDates, '2026-02-28');

    expect(trade).not.toBeNull();
    expect(trade!.mode).toBe('DEBIT_SPREAD');
    expect(trade!.direction).toBe('CALL');
    expect(trade!.exitType).toBe('PROFIT_TARGET');
    expect(trade!.exitDate).toBe('2026-01-15');
    // PnL = (14 - 8) * 100 = 600
    expect(trade!.pnl).toBeCloseTo(600, 0);
  });

  it('bear put variant: direction=PUT picks puts with correct strike ordering', () => {
    // For PUT bear debit: long higher |delta| = lower strike? No — higher |delta| put is HIGHER strike (ATM/ITM).
    // Bear put debit: buy ITM put (higher strike, higher delta), sell OTM put (lower strike, lower delta).
    // Here: long put at strike 420 (delta -0.50 abs=0.50), short put at strike 400 (delta -0.20 abs=0.20).
    mockChainByDate.set('2026-01-05', [
      { ...makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-02-20', dte: 46, strike: 420, spot: 410, callBid: 0, callMid: 0, callAsk: 0, delta: 0.50 }),
        put_bid: 9.9, put_mid: 10, put_ask: 10.1 },
      { ...makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-02-20', dte: 46, strike: 400, spot: 410, callBid: 0, callMid: 0, callAsk: 0, delta: 0.20 }),
        put_bid: 1.9, put_mid: 2, put_ask: 2.1 },
    ]);
    mockChainByDate.set('2026-01-15', [
      { ...makeRow({ ticker: 'QQQ', date: '2026-01-15', expiry: '2026-02-20', dte: 36, strike: 420, spot: 400, callBid: 0, callMid: 0, callAsk: 0, delta: 0.65 }),
        put_bid: 16, put_mid: 16, put_ask: 16 },
      { ...makeRow({ ticker: 'QQQ', date: '2026-01-15', expiry: '2026-02-20', dte: 36, strike: 400, spot: 400, callBid: 0, callMid: 0, callAsk: 0, delta: 0.25 }),
        put_bid: 2, put_mid: 2, put_ask: 2 },
    ]);

    const evaluator = makeDebitSpreadEvaluator(BASE_CONFIG);
    const signal: EntrySignal = { ticker: 'QQQ', date: '2026-01-05', direction: 'PUT', score: 0 };
    const allDates = buildWeekdays('2026-01-05', '2026-02-20');

    const trade = evaluator(signal, BASE_CONFIG, allDates, '2026-02-28');

    expect(trade).not.toBeNull();
    expect(trade!.mode).toBe('DEBIT_SPREAD');
    expect(trade!.direction).toBe('PUT');
    // Long leg strike should be the higher-delta (0.50) put at strike 420
    expect(trade!.strike).toBe(420);
    // Short leg (stored in longStrike field) should be strike 400 (lower delta put)
    expect(trade!.longStrike).toBe(400);
  });
});

describe('makeDebitSpreadEvaluator — reliability fixes (Codex findings)', () => {
  beforeEach(() => mockChainByDate.clear());

  it('same-expiry retry: reassigns shortMatch when first match has wrong expiry', () => {
    // Deliberate setup: in the initial DTE range [30, 60], there are TWO expiries,
    // 2026-02-20 (46 DTE) and 2026-03-20 (74 DTE, outside).
    // Long leg (delta 0.50) picks 2026-02-20.
    // Short leg candidate closest to delta 0.20 happens to be on 2026-03-20 (wrong expiry).
    // The retry with exact-DTE-46 should find a same-expiry short leg at 2026-02-20.
    mockChainByDate.set('2026-01-05', [
      // Long call candidate — delta 0.50 at strike 400 on 2026-02-20 expiry.
      makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-02-20', dte: 46, strike: 400, spot: 400, callBid: 9.9, callMid: 10, callAsk: 10.1, delta: 0.50 }),
      // Same-expiry short leg candidate at delta 0.20, strike 420.
      makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-02-20', dte: 46, strike: 420, spot: 400, callBid: 1.9, callMid: 2, callAsk: 2.1, delta: 0.20 }),
      // Far-expiry short leg with EXACT delta 0.20 — initial findStrikeByDelta would prefer this match.
      makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-03-20', dte: 74, strike: 430, spot: 400, callBid: 4, callMid: 4.1, callAsk: 4.2, delta: 0.20 }),
    ]);
    mockChainByDate.set('2026-01-15', [
      makeRow({ ticker: 'QQQ', date: '2026-01-15', expiry: '2026-02-20', dte: 36, strike: 400, spot: 410, callBid: 16, callMid: 16, callAsk: 16, delta: 0.65 }),
      makeRow({ ticker: 'QQQ', date: '2026-01-15', expiry: '2026-02-20', dte: 36, strike: 420, spot: 410, callBid: 2, callMid: 2, callAsk: 2, delta: 0.25 }),
    ]);

    // Tighten DTE range so initial pick spans both 46 and 74 DTE but retry only allows 46.
    const config: SimConfig = { ...BASE_CONFIG, debitDTERange: [30, 80] };
    const evaluator = makeDebitSpreadEvaluator(config);
    const signal: EntrySignal = { ticker: 'QQQ', date: '2026-01-05', direction: 'CALL', score: 0 };
    const allDates = buildWeekdays('2026-01-05', '2026-02-20');

    const trade = evaluator(signal, config, allDates, '2026-02-28');

    // Pre-fix behavior: shortMatch would point at strike 430 (far expiry), and the
    // post-retry check at line 758 returns null. Post-fix: shortMatch reassigned
    // to strike 420 same-expiry and trade opens successfully.
    expect(trade).not.toBeNull();
    expect(trade!.strike).toBe(400);  // long leg
    expect(trade!.longStrike).toBe(420);  // short leg (same expiry)
    expect(trade!.expiry).toBe('2026-02-20');
  });

  it('debitMaxHoldDays enforced: forces exit when held for N days even without PT or TIME_STOP', () => {
    // Entry at 2026-01-05. Set debitMaxHoldDays=5 (very short). No profit target reached.
    // Every monitoring day, spread mid = debit (no movement). Force-close on day 5.
    const dates = buildWeekdays('2026-01-05', '2026-02-20');
    for (const d of dates) {
      const dte = Math.max(0, 46 - dates.indexOf(d));
      mockChainByDate.set(d, [
        makeRow({ ticker: 'QQQ', date: d, expiry: '2026-02-20', dte, strike: 400, spot: 400, callBid: 9.9, callMid: 10, callAsk: 10.1, delta: 0.50 }),
        makeRow({ ticker: 'QQQ', date: d, expiry: '2026-02-20', dte, strike: 420, spot: 400, callBid: 1.9, callMid: 2, callAsk: 2.1, delta: 0.20 }),
      ]);
    }

    const config: SimConfig = { ...BASE_CONFIG, debitMaxHoldDays: 5, debitMinExitDTE: 0 };
    const evaluator = makeDebitSpreadEvaluator(config);
    const signal: EntrySignal = { ticker: 'QQQ', date: '2026-01-05', direction: 'CALL', score: 0 };

    const trade = evaluator(signal, config, dates, '2026-02-28');

    expect(trade).not.toBeNull();
    expect(trade!.exitType).toBe('FORCE_CLOSE');
    expect(trade!.holdDays).toBe(5);
  });

  it('missing-chain force-close: 3 consecutive missing days trigger FORCE_CLOSE', () => {
    // Entry 2026-01-05, monitoring covers 2026-01-06 through 2026-01-08 (3 trading days).
    // Entry data present, mid-hold data present for day 1, then 3 consecutive missing days.
    mockChainByDate.set('2026-01-05', [
      makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-02-20', dte: 46, strike: 400, spot: 400, callBid: 9.9, callMid: 10, callAsk: 10.1, delta: 0.50 }),
      makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-02-20', dte: 46, strike: 420, spot: 400, callBid: 1.9, callMid: 2, callAsk: 2.1, delta: 0.20 }),
    ]);
    mockChainByDate.set('2026-01-06', [
      makeRow({ ticker: 'QQQ', date: '2026-01-06', expiry: '2026-02-20', dte: 45, strike: 400, spot: 402, callBid: 11, callMid: 11, callAsk: 11, delta: 0.53 }),
      makeRow({ ticker: 'QQQ', date: '2026-01-06', expiry: '2026-02-20', dte: 45, strike: 420, spot: 402, callBid: 2.5, callMid: 2.5, callAsk: 2.5, delta: 0.22 }),
    ]);
    // 2026-01-07, 08, 09 NOT set → missing chain for 3 consecutive days → FORCE_CLOSE on day 3 of missing.

    const dates = buildWeekdays('2026-01-05', '2026-01-15');
    const config: SimConfig = { ...BASE_CONFIG, missingChainExitAfterDays: 3 };
    const evaluator = makeDebitSpreadEvaluator(config);
    const signal: EntrySignal = { ticker: 'QQQ', date: '2026-01-05', direction: 'CALL', score: 0 };

    const trade = evaluator(signal, config, dates, '2026-02-28');

    expect(trade).not.toBeNull();
    expect(trade!.exitType).toBe('FORCE_CLOSE');
    // Exit date is the day the missing-chain cap was hit (3rd consecutive miss after the last successful mark).
    // Successful marks: 2026-01-06. Misses on 01-07, 01-08, 01-09 → force-close on 01-09.
    expect(trade!.exitDate).toBe('2026-01-09');
  });
});

describe('makeDebitSpreadEvaluator — validation guards', () => {
  beforeEach(() => mockChainByDate.clear());

  it('throws when required debit* config fields are missing', () => {
    const badConfig = { ...BASE_CONFIG, debitLongDelta: undefined } as unknown as SimConfig;
    const evaluator = makeDebitSpreadEvaluator(badConfig);
    const signal: EntrySignal = { ticker: 'QQQ', date: '2026-01-05', direction: 'CALL', score: 0 };

    mockChainByDate.set('2026-01-05', [
      makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-02-20', dte: 46, strike: 400, spot: 400, callBid: 9.9, callMid: 10, callAsk: 10.1, delta: 0.50 }),
    ]);

    expect(() => evaluator(signal, badConfig, ['2026-01-05'], '2026-02-28'))
      .toThrow(/requires debit\* config fields/);
  });

  it('throws when debitShortDelta >= debitLongDelta (wrong spread direction)', () => {
    const badConfig: SimConfig = { ...BASE_CONFIG, debitShortDelta: 0.60, debitLongDelta: 0.50 };
    const evaluator = makeDebitSpreadEvaluator(badConfig);
    const signal: EntrySignal = { ticker: 'QQQ', date: '2026-01-05', direction: 'CALL', score: 0 };

    mockChainByDate.set('2026-01-05', [
      makeRow({ ticker: 'QQQ', date: '2026-01-05', expiry: '2026-02-20', dte: 46, strike: 400, spot: 400, callBid: 9.9, callMid: 10, callAsk: 10.1, delta: 0.50 }),
    ]);

    expect(() => evaluator(signal, badConfig, ['2026-01-05'], '2026-02-28'))
      .toThrow(/must be <|debitShortDelta/);
  });
});
