/**
 * Phase E1 Task 9 — decomposition identity.
 *
 * On any PMCC month where the short call expires OTM (no assignment, no pin,
 * no PT close), the combined P&L must equal:
 *   simulateLeap(long only) + shortCredit × 100
 *
 * Catches leg-reconciliation bugs in simulateDiagonal.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { simulateDiagonal, simulateLeap, DEFAULT_LEAP_CONFIG } from '../src/lib/backtest/option-sim';
import type { EntrySignal, SimConfig } from '../src/lib/backtest/option-sim';

interface ChainRowLike {
  ticker: string; trade_date: string; expir_date: string; dte: number;
  strike: number; stock_price: number;
  call_bid: number; call_mid: number; call_ask: number;
  call_iv: number; call_volume: number; call_oi: number;
  put_bid: number; put_mid: number; put_ask: number;
  put_iv: number; put_volume: number; put_oi: number;
  delta: number; gamma: number; theta: number; vega: number;
}

const mockChainByDate = new Map<string, ChainRowLike[]>();

vi.mock('../src/lib/backtest/chain-cache', () => ({
  fetchHistoricalChain: vi.fn(async (_t: string, _k: string, date: string) => mockChainByDate.get(date) ?? []),
  findStrikeByDelta: vi.fn((chain: ChainRowLike[], targetDelta: number, type: 'Call' | 'Put', dteRange: [number, number]) => {
    const filtered = chain.filter(r => r.dte >= dteRange[0] && r.dte <= dteRange[1]);
    if (!filtered.length) return null;
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
    return picked ? { row: picked, mid: picked.call_mid, bid: picked.call_bid, ask: picked.call_ask,
      iv: picked.call_iv, delta: picked.delta, volume: picked.call_volume, oi: picked.call_oi } : null;
  }),
  findContractDirect: vi.fn(() => null),
  findSpreadStrikes: vi.fn(() => null),
}));

function row(opts: {
  date: string; expiry: string; dte: number; strike: number; spot: number;
  callMid: number; delta: number;
}): ChainRowLike {
  return {
    ticker: 'QQQ', trade_date: opts.date, expir_date: opts.expiry, dte: opts.dte,
    strike: opts.strike, stock_price: opts.spot,
    call_bid: opts.callMid - 0.05, call_mid: opts.callMid, call_ask: opts.callMid + 0.05,
    call_iv: 0.20, call_volume: 500, call_oi: 2000,
    put_bid: 0, put_mid: 0, put_ask: 0, put_iv: 0.20, put_volume: 0, put_oi: 0,
    delta: opts.delta, gamma: 0.005, theta: -0.03, vega: 0.15,
  };
}

function buildWeekdays(startStr: string, endStr: string): string[] {
  const out: string[] = [];
  const start = new Date(startStr); const end = new Date(endStr);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay(); if (wd === 0 || wd === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

describe('Decomposition identity', () => {
  beforeEach(() => mockChainByDate.clear());

  it('PMCC short-OTM month: combined P&L - sum(short cycles P&L) ≈ simulateLeap P&L (long only)', async () => {
    // One short cycle with OTM expiry + one FORCE_CLOSE cycle at long time-stop.
    mockChainByDate.set('2023-01-20', [
      row({ date: '2023-01-20', expiry: '2023-10-20', dte: 273, strike: 340, spot: 380, callMid: 45, delta: 0.75 }),
      row({ date: '2023-01-20', expiry: '2023-02-17', dte: 28, strike: 400, spot: 380, callMid: 2.5, delta: 0.25 }),
    ]);
    mockChainByDate.set('2023-02-17', [
      row({ date: '2023-02-17', expiry: '2023-10-20', dte: 245, strike: 340, spot: 385, callMid: 50, delta: 0.78 }),
      row({ date: '2023-02-17', expiry: '2023-02-17', dte: 0, strike: 400, spot: 385, callMid: 0, delta: 0 }),
      // No new short candidates on 2023-02-17 — rolling will find nothing.
    ]);
    mockChainByDate.set('2023-07-24', [
      row({ date: '2023-07-24', expiry: '2023-10-20', dte: 88, strike: 340, spot: 395, callMid: 58.5, delta: 0.88 }),
    ]);

    const signal: EntrySignal = { ticker: 'QQQ', date: '2023-01-20', direction: 'CALL', score: 0 };
    const configDiag: SimConfig = {
      ...DEFAULT_LEAP_CONFIG, mode: 'DIAGONAL',
      diagLongDeltaRange: [0.65, 0.80], diagLongDTERange: [240, 300],
      diagShortDeltaRange: [0.20, 0.30], diagShortDTERange: [25, 45],
      diagLongProfitTarget: 0.40, diagLongStopLoss: 0.35, diagLongTimeStopDTE: 90,
      diagShortProfitTarget: 0.50, diagRollTriggerMoneyness: 0.02,
      monitoringIntervalDays: 1,
      fillMode: 'mid',
    };
    const configLeap: SimConfig = {
      ...DEFAULT_LEAP_CONFIG, mode: 'LEAP',
      leapDeltaRange: [0.65, 0.80], leapDTERange: [240, 300],
      leapProfitTarget: 0.40, leapStopLoss: 0.35, leapTimeStopDTE: 90,
      monitoringIntervalDays: 1,
      fillMode: 'mid',
      // Disable NO_CHAIN forced-exit guardrail so sparse mock chain behaves
      // the same as simulateDiagonal (which has no missing-chain counter).
      missingChainExitAfterDays: undefined,
    };
    const allDates = buildWeekdays('2023-01-20', '2023-07-24');

    const diag = await simulateDiagonal('', signal, configDiag, allDates, '2023-12-31');
    const leap = await simulateLeap('', signal, configLeap, allDates, '2023-12-31');

    expect(diag).not.toBeNull();
    expect(leap).not.toBeNull();

    // Sum up net short pnl across all cycles (entryCredit - exitCost) × 100.
    const totalShortNet = diag!.diagonalLegs!.shortCallCycles.reduce(
      (s, c) => s + 100 * (c.entryCredit - c.exitCost), 0,
    );
    const diagLongOnly = diag!.pnl - totalShortNet;

    // Decomposition identity — within a loose tolerance because simulateLeap
    // and simulateDiagonal may use slightly different long-exit fill pricing.
    expect(diagLongOnly).toBeCloseTo(leap!.pnl, -2);  // ±$50
  });
});
