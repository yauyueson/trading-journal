/**
 * Phase E1 — unit tests for simulateDiagonal (PMCC).
 * Mocks chain-cache so tests are self-contained.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { OptionMode, OptionTrade, SimConfig } from '../src/lib/backtest/option-sim';
import { computeOptionAnalytics, simulateDiagonal, DEFAULT_LEAP_CONFIG } from '../src/lib/backtest/option-sim';
import type { EntrySignal } from '../src/lib/backtest/option-sim';

// Chain row shape for mocks (same as buy-write tests)
interface ChainRowLike {
  ticker: string; trade_date: string; expir_date: string; dte: number;
  strike: number; stock_price: number;
  call_bid: number; call_mid: number; call_ask: number;
  call_iv: number; call_volume: number; call_oi: number;
  put_bid: number; put_mid: number; put_ask: number;
  put_iv: number; put_volume: number; put_oi: number;
  delta: number; gamma: number; theta: number; vega: number;
}

function makeDiagonalChainRow(opts: {
  ticker: string; date: string; expiry: string; dte: number;
  strike: number; spot: number; callBid: number; callMid: number; callAsk: number;
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
  fetchHistoricalChain: vi.fn(async (_t: string, _k: string, date: string) => {
    return mockChainByDate.get(date) ?? [];
  }),
  findStrikeByDelta: vi.fn((chain: ChainRowLike[], targetDelta: number, type: 'Call' | 'Put', dteRange: [number, number]) => {
    const filtered = chain.filter(r => r.dte >= dteRange[0] && r.dte <= dteRange[1]);
    if (filtered.length === 0) return null;
    const picked = filtered.reduce((best, r) => Math.abs((r.delta ?? 0) - targetDelta) < Math.abs((best.delta ?? 0) - targetDelta) ? r : best);
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
    return {
      row: picked, bid: picked.call_bid, mid: picked.call_mid, ask: picked.call_ask,
      iv: picked.call_iv, delta: picked.delta, volume: picked.call_volume, oi: picked.call_oi,
    };
  }),
  findContractDirect: vi.fn(() => null),  // force fallback to fetchHistoricalChain in simulator
  findSpreadStrikes: vi.fn(() => null),
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

describe('Type extensions for DIAGONAL', () => {
  it('OptionMode union includes DIAGONAL', () => {
    const m: OptionMode = 'DIAGONAL';
    expect(m).toBe('DIAGONAL');
  });

  it('OptionTrade has diagonalLegs shape', () => {
    const trade: Partial<OptionTrade> = {
      mode: 'DIAGONAL',
      diagonalLegs: {
        longCall: {
          strike: 400, entryPrice: 45, exitPrice: 50, entryDate: '2023-01-20', exitDate: '2023-10-20',
        },
        shortCallCycles: [
          { strike: 420, entryDate: '2023-01-20', exitDate: '2023-02-17', entryCredit: 2.5, exitCost: 0.2, exitReason: 'EXPIRATION' },
        ],
      },
    };
    expect(trade.mode).toBe('DIAGONAL');
    expect(trade.diagonalLegs?.shortCallCycles).toHaveLength(1);
  });

  it('SimConfig has diag* fields', () => {
    const c: Partial<SimConfig> = {
      mode: 'DIAGONAL',
      diagLongDeltaRange: [0.65, 0.80],
      diagLongDTERange: [240, 300],
      diagShortDeltaRange: [0.20, 0.30],
      diagShortDTERange: [30, 45],
      diagLongProfitTarget: 0.40,
      diagLongStopLoss: 0.35,
      diagLongTimeStopDTE: 90,
      diagShortProfitTarget: 0.50,
      diagRollTriggerMoneyness: 0.02,
    };
    expect(c.mode).toBe('DIAGONAL');
  });
});

describe('Dispatcher guards', () => {
  it('eval-worker source contains explicit throw on DIAGONAL', async () => {
    const fs = await import('fs/promises');
    const src = await fs.readFile('scripts/eval-worker.ts', 'utf-8');
    expect(src).toMatch(/mode === 'DIAGONAL'/);
    expect(src).toMatch(/DIAGONAL requires simulateDiagonal/);
  });

  it('autoresearch/worker source contains explicit throw on DIAGONAL', async () => {
    const fs = await import('fs/promises');
    const src = await fs.readFile('scripts/autoresearch/worker.ts', 'utf-8');
    expect(src).toMatch(/mode === 'DIAGONAL'/);
    expect(src).toMatch(/DIAGONAL requires simulateDiagonal/);
  });
});

function makeDiagonalTrade(longEntry: number, shortEntry: number): OptionTrade {
  return {
    ticker: 'QQQ', mode: 'DIAGONAL', direction: 'CALL',
    entryDate: '2023-01-20', entrySignalScore: 0,
    strike: 400, expiry: '2023-10-20', entryDTE: 273,
    entryPrice: longEntry - shortEntry,  // net debit per contract
    entryDelta: 0.75, entryIV: 0.20, entryStockPrice: 380,
    exitDate: '2023-10-20', exitPrice: 0, exitDTE: 0, exitStockPrice: 410,
    exitType: 'TIME_STOP', pnl: 0, pnlPct: 0, holdDays: 273,
    diagonalLegs: {
      longCall: { strike: 400, entryPrice: longEntry, exitPrice: longEntry, entryDate: '2023-01-20', exitDate: '2023-10-20' },
      shortCallCycles: [
        { strike: 420, entryDate: '2023-01-20', exitDate: '2023-02-17', entryCredit: shortEntry, exitCost: 0, exitReason: 'EXPIRATION' },
      ],
    },
  };
}

describe('Capital at risk for DIAGONAL', () => {
  it('computeOptionAnalytics uses net debit × 100', () => {
    const trade = makeDiagonalTrade(45, 2.5);  // long 45, short 2.5 → net 42.5
    const ana = computeOptionAnalytics([trade]);
    expect(ana.avgCapitalPerTrade).toBeCloseTo(4250, 1);
  });

  it('capital uses diagonalLegs not entryPrice', () => {
    const trade = makeDiagonalTrade(45, 2.5);
    trade.entryPrice = 0;  // deliberate: force the analytics to use the legs
    const ana = computeOptionAnalytics([trade]);
    expect(ana.avgCapitalPerTrade).toBeCloseTo(4250, 1);
  });
});

describe('simulateDiagonal happy path', () => {
  beforeEach(() => {
    mockChainByDate.clear();
  });

  it('opens PMCC, holds through short expiry (OTM), closes at long time-stop', async () => {
    // QQQ at $380 on 2023-01-20 (Friday).
    // Long LEAP: strike 340 (delta 0.75), expiry 2023-10-20 (273 DTE), premium ~$45.
    // Short call: strike 400 (delta 0.25), expiry 2023-02-17 (28 DTE), credit ~$2.50.
    // QQQ drifts to $385 by 2023-02-17 (short expires OTM).
    // Long closed at time-stop DTE=88 on 2023-07-24 (Monday; 2023-07-22 is a Saturday).

    mockChainByDate.set('2023-01-20', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-01-20', expiry: '2023-10-20', dte: 273, strike: 340, spot: 380, callBid: 44.9, callMid: 45, callAsk: 45.1, delta: 0.75 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-01-20', expiry: '2023-02-17', dte: 28, strike: 400, spot: 380, callBid: 2.4, callMid: 2.5, callAsk: 2.6, delta: 0.25 }),
    ]);
    mockChainByDate.set('2023-02-17', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-17', expiry: '2023-10-20', dte: 245, strike: 340, spot: 385, callBid: 49.9, callMid: 50, callAsk: 50.1, delta: 0.78 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-17', expiry: '2023-02-17', dte: 0, strike: 400, spot: 385, callBid: 0, callMid: 0, callAsk: 0.05, delta: 0 }),
    ]);
    // 2023-07-24 (Monday): dte=88 from 2023-10-20, triggers diagLongTimeStopDTE=90.
    mockChainByDate.set('2023-07-24', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-07-24', expiry: '2023-10-20', dte: 88, strike: 340, spot: 395, callBid: 58, callMid: 58.5, callAsk: 59, delta: 0.88 }),
    ]);

    const signal: EntrySignal = { ticker: 'QQQ', date: '2023-01-20', direction: 'CALL', score: 0 };
    const config: SimConfig = {
      ...DEFAULT_LEAP_CONFIG,
      mode: 'DIAGONAL',
      diagLongDeltaRange: [0.65, 0.80],
      diagLongDTERange: [240, 300],
      diagShortDeltaRange: [0.20, 0.30],
      diagShortDTERange: [25, 45],
      diagLongProfitTarget: 0.40,
      diagLongStopLoss: 0.35,
      diagLongTimeStopDTE: 90,
      diagShortProfitTarget: 0.50,
      diagRollTriggerMoneyness: 0.02,
      monitoringIntervalDays: 1,
    };
    const allDates = buildWeekdays('2023-01-20', '2023-07-24');

    const trade = await simulateDiagonal('', signal, config, allDates, '2023-12-31');

    expect(trade).not.toBeNull();
    expect(trade!.mode).toBe('DIAGONAL');
    expect(trade!.diagonalLegs!.longCall.strike).toBe(340);
    expect(trade!.diagonalLegs!.shortCallCycles).toHaveLength(1);
    expect(trade!.diagonalLegs!.shortCallCycles[0].exitReason).toBe('EXPIRATION');
    expect(trade!.diagonalLegs!.shortCallCycles[0].exitCost).toBeCloseTo(0, 1);
    expect(trade!.pnl).toBeGreaterThan(1500);
    expect(trade!.pnl).toBeLessThan(1700);
    expect(trade!.exitType).toBe('TIME_STOP');
  });
});

describe('Short-cycle state machine', () => {
  beforeEach(() => mockChainByDate.clear());

  it('closes short at profit target (50% of credit)', async () => {
    // Short call decays from $2.50 → $1.20 (52% profit) on day 2023-02-03.
    mockChainByDate.set('2023-01-20', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-01-20', expiry: '2023-10-20', dte: 273, strike: 340, spot: 380, callBid: 44.9, callMid: 45, callAsk: 45.1, delta: 0.75 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-01-20', expiry: '2023-02-17', dte: 28, strike: 400, spot: 380, callBid: 2.4, callMid: 2.5, callAsk: 2.6, delta: 0.25 }),
    ]);
    mockChainByDate.set('2023-02-03', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-03', expiry: '2023-10-20', dte: 259, strike: 340, spot: 381, callBid: 46, callMid: 46.5, callAsk: 47, delta: 0.76 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-03', expiry: '2023-02-17', dte: 14, strike: 400, spot: 381, callBid: 1.1, callMid: 1.2, callAsk: 1.3, delta: 0.15 }),
    ]);
    // Long time-stop day — use 2023-07-24 (Monday, DTE=88 for 2023-10-20 long)
    mockChainByDate.set('2023-07-24', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-07-24', expiry: '2023-10-20', dte: 88, strike: 340, spot: 395, callBid: 58, callMid: 58.5, callAsk: 59, delta: 0.88 }),
    ]);

    const signal: EntrySignal = { ticker: 'QQQ', date: '2023-01-20', direction: 'CALL', score: 0 };
    const config: SimConfig = { ...DEFAULT_LEAP_CONFIG, mode: 'DIAGONAL',
      fillMode: 'mid',  // mid-fill so entryCredit = call_mid exactly, keeping pnlPct math clean
      diagLongDeltaRange: [0.65, 0.80], diagLongDTERange: [240, 300],
      diagShortDeltaRange: [0.20, 0.30], diagShortDTERange: [25, 45],
      diagLongProfitTarget: 0.40, diagLongStopLoss: 0.35, diagLongTimeStopDTE: 90,
      diagShortProfitTarget: 0.50, diagRollTriggerMoneyness: 0.02,
      monitoringIntervalDays: 1 };
    const allDates = buildWeekdays('2023-01-20', '2023-07-24');

    const trade = await simulateDiagonal('', signal, config, allDates, '2023-12-31');
    expect(trade).not.toBeNull();
    expect(trade!.diagonalLegs!.shortCallCycles).toHaveLength(1);
    expect(trade!.diagonalLegs!.shortCallCycles[0].exitReason).toBe('PROFIT_TARGET');
    expect(trade!.diagonalLegs!.shortCallCycles[0].exitDate).toBe('2023-02-03');
  });

  it('closes short via pin-risk rule when spot within 2% of strike at DTE ≤ 2', async () => {
    // Short strike 400, spot 398 (0.5% away), DTE 2 on 2023-02-15.
    mockChainByDate.set('2023-01-20', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-01-20', expiry: '2023-10-20', dte: 273, strike: 340, spot: 380, callBid: 44.9, callMid: 45, callAsk: 45.1, delta: 0.75 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-01-20', expiry: '2023-02-17', dte: 28, strike: 400, spot: 380, callBid: 2.4, callMid: 2.5, callAsk: 2.6, delta: 0.25 }),
    ]);
    mockChainByDate.set('2023-02-15', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-15', expiry: '2023-10-20', dte: 247, strike: 340, spot: 398, callBid: 60, callMid: 60.5, callAsk: 61, delta: 0.92 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-15', expiry: '2023-02-17', dte: 2, strike: 400, spot: 398, callBid: 0.80, callMid: 0.85, callAsk: 0.90, delta: 0.38 }),
    ]);
    mockChainByDate.set('2023-07-24', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-07-24', expiry: '2023-10-20', dte: 88, strike: 340, spot: 395, callBid: 58, callMid: 58.5, callAsk: 59, delta: 0.88 }),
    ]);

    const signal: EntrySignal = { ticker: 'QQQ', date: '2023-01-20', direction: 'CALL', score: 0 };
    const config: SimConfig = { ...DEFAULT_LEAP_CONFIG, mode: 'DIAGONAL',
      fillMode: 'mid',  // mid-fill keeps entry credit = call_mid; pin-risk fires on DTE/moneyness only
      diagLongDeltaRange: [0.65, 0.80], diagLongDTERange: [240, 300],
      diagShortDeltaRange: [0.20, 0.30], diagShortDTERange: [25, 45],
      diagLongProfitTarget: 0.40, diagLongStopLoss: 0.35, diagLongTimeStopDTE: 90,
      diagShortProfitTarget: 0.50, diagRollTriggerMoneyness: 0.02,
      monitoringIntervalDays: 1 };
    const allDates = buildWeekdays('2023-01-20', '2023-07-24');

    const trade = await simulateDiagonal('', signal, config, allDates, '2023-12-31');
    expect(trade!.diagonalLegs!.shortCallCycles[0].exitReason).toBe('PIN_ROLL');
    expect(trade!.diagonalLegs!.shortCallCycles[0].exitDate).toBe('2023-02-15');
  });
});

describe('Short-cycle rolling', () => {
  beforeEach(() => mockChainByDate.clear());

  it('rolls into a new short cycle after the first expires', async () => {
    // Cycle 1: short 2023-02-17 expiry, OTM expiry.
    // Cycle 2: short 2023-03-17 expiry, opened on 2023-02-17 right after cycle 1 closes.
    mockChainByDate.set('2023-01-20', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-01-20', expiry: '2023-10-20', dte: 273, strike: 340, spot: 380, callBid: 44.9, callMid: 45, callAsk: 45.1, delta: 0.75 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-01-20', expiry: '2023-02-17', dte: 28, strike: 400, spot: 380, callBid: 2.4, callMid: 2.5, callAsk: 2.6, delta: 0.25 }),
    ]);
    // On 2023-02-17: cycle 1 expires; chain offers a 2023-03-17 short (28 DTE).
    mockChainByDate.set('2023-02-17', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-17', expiry: '2023-10-20', dte: 245, strike: 340, spot: 385, callBid: 49.9, callMid: 50, callAsk: 50.1, delta: 0.78 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-17', expiry: '2023-02-17', dte: 0, strike: 400, spot: 385, callBid: 0, callMid: 0, callAsk: 0.05, delta: 0 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-17', expiry: '2023-03-17', dte: 28, strike: 405, spot: 385, callBid: 2.0, callMid: 2.1, callAsk: 2.2, delta: 0.25 }),
    ]);
    mockChainByDate.set('2023-03-17', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-03-17', expiry: '2023-10-20', dte: 217, strike: 340, spot: 390, callBid: 53, callMid: 53.5, callAsk: 54, delta: 0.80 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-03-17', expiry: '2023-03-17', dte: 0, strike: 405, spot: 390, callBid: 0, callMid: 0, callAsk: 0.05, delta: 0 }),
    ]);
    // Time-stop day — 2023-07-24 Monday
    mockChainByDate.set('2023-07-24', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-07-24', expiry: '2023-10-20', dte: 88, strike: 340, spot: 395, callBid: 58, callMid: 58.5, callAsk: 59, delta: 0.88 }),
    ]);

    const signal: EntrySignal = { ticker: 'QQQ', date: '2023-01-20', direction: 'CALL', score: 0 };
    const config: SimConfig = { ...DEFAULT_LEAP_CONFIG, mode: 'DIAGONAL',
      diagLongDeltaRange: [0.65, 0.80], diagLongDTERange: [240, 300],
      diagShortDeltaRange: [0.20, 0.30], diagShortDTERange: [25, 45],
      diagLongProfitTarget: 0.40, diagLongStopLoss: 0.35, diagLongTimeStopDTE: 90,
      diagShortProfitTarget: 0.50, diagRollTriggerMoneyness: 0.02,
      monitoringIntervalDays: 1 };
    const allDates = buildWeekdays('2023-01-20', '2023-07-24');

    const trade = await simulateDiagonal('', signal, config, allDates, '2023-12-31');
    expect(trade!.diagonalLegs!.shortCallCycles.length).toBeGreaterThanOrEqual(2);
    expect(trade!.diagonalLegs!.shortCallCycles[0].exitDate).toBe('2023-02-17');
    expect(trade!.diagonalLegs!.shortCallCycles[1].entryDate).toBe('2023-02-17');
    expect(trade!.diagonalLegs!.shortCallCycles[1].strike).toBe(405);
  });
});

describe('Short assignment', () => {
  beforeEach(() => mockChainByDate.clear());

  it('short expires ITM → assignment cost caps the short leg P&L', async () => {
    // Short strike 400 expires with spot 408 → ITM by $8.
    // Cycle P&L = entryCredit ($2.50) - exitCost ($8.00) = -$5.50/share → -$550.
    mockChainByDate.set('2023-01-20', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-01-20', expiry: '2023-10-20', dte: 273, strike: 340, spot: 380, callBid: 44.9, callMid: 45, callAsk: 45.1, delta: 0.75 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-01-20', expiry: '2023-02-17', dte: 28, strike: 400, spot: 380, callBid: 2.4, callMid: 2.5, callAsk: 2.6, delta: 0.25 }),
    ]);
    mockChainByDate.set('2023-02-17', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-17', expiry: '2023-10-20', dte: 245, strike: 340, spot: 408, callBid: 70, callMid: 70.5, callAsk: 71, delta: 0.95 }),
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-02-17', expiry: '2023-02-17', dte: 0, strike: 400, spot: 408, callBid: 7.9, callMid: 8, callAsk: 8.1, delta: 1.0 }),
    ]);
    mockChainByDate.set('2023-07-24', [
      makeDiagonalChainRow({ ticker: 'QQQ', date: '2023-07-24', expiry: '2023-10-20', dte: 88, strike: 340, spot: 395, callBid: 58, callMid: 58.5, callAsk: 59, delta: 0.88 }),
    ]);

    const signal: EntrySignal = { ticker: 'QQQ', date: '2023-01-20', direction: 'CALL', score: 0 };
    const config: SimConfig = { ...DEFAULT_LEAP_CONFIG, mode: 'DIAGONAL',
      diagLongDeltaRange: [0.65, 0.80], diagLongDTERange: [240, 300],
      diagShortDeltaRange: [0.20, 0.30], diagShortDTERange: [25, 45],
      diagLongProfitTarget: 0.40, diagLongStopLoss: 0.35, diagLongTimeStopDTE: 90,
      diagShortProfitTarget: 0.50, diagRollTriggerMoneyness: 0.02,
      monitoringIntervalDays: 1,
      fillMode: 'mid',
    };
    const allDates = buildWeekdays('2023-01-20', '2023-07-24');

    const trade = await simulateDiagonal('', signal, config, allDates, '2023-12-31');
    expect(trade).not.toBeNull();
    const cycle = trade!.diagonalLegs!.shortCallCycles[0];
    expect(cycle.exitReason).toBe('ASSIGNED');
    expect(cycle.exitCost).toBeCloseTo(8, 1);
    const cyclePnl = 100 * (cycle.entryCredit - cycle.exitCost);
    expect(cyclePnl).toBeCloseTo(-550, 0);
  });
});
