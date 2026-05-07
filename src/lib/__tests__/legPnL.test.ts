import { describe, it, expect } from 'vitest';
import { computeLegBasedPnL, isCycleRollTransaction } from '../legPnL';
import type { Position } from '../types';

const basePosition: Position = {
  id: 'p1',
  ticker: 'QQQ',
  strike: 600,
  type: 'PMCC Diagonal',
  expiration: '2027-01-15',
  status: 'active',
  setup: 'PMCC',
  entry_score: 0,
  current_score: 0,
};

describe('computeLegBasedPnL', () => {
  it('returns null for a position with no legs', () => {
    expect(computeLegBasedPnL({ ...basePosition })).toBeNull();
  });

  it('reports unrealized P&L for an open PMCC long + active short with marks', () => {
    const position: Position = {
      ...basePosition,
      legs: [
        { strike: 600, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 100, cycleQty: 1 },
        { strike: 700, type: 'Call', side: 'short', expiration: '2026-06-15', openedCredit: 4, cycleQty: 1 },
      ],
    };
    const result = computeLegBasedPnL(position, [110, 3])!;

    // long unrealized = (110 - 100) * 100 * 1 = 1000
    // short unrealized = (4 - 3) * 100 * 1 = 100
    expect(result.unrealized).toBeCloseTo(1100);
    expect(result.realized).toBe(0);
    expect(result.complete).toBe(true);
    expect(result.perLeg).toHaveLength(2);
    expect(result.perLeg[0]).toMatchObject({ legIndex: 0, status: 'open', unrealized: 1000 });
    expect(result.perLeg[1]).toMatchObject({ legIndex: 1, status: 'open', unrealized: 100 });
  });

  it('captures realized P&L from a closed short cycle (PMCC roll)', () => {
    const position: Position = {
      ...basePosition,
      legs: [
        { strike: 600, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 100, cycleQty: 1 },
        { strike: 720, type: 'Call', side: 'short', expiration: '2026-07-15', openedCredit: 5, cycleQty: 1 },
        // closed prior cycle
        { strike: 700, type: 'Call', side: 'short', expiration: '2026-06-15', openedCredit: 4, closedCost: 1.5, closedAt: '2026-05-15T20:00:00Z', cycleQty: 1 },
      ],
    };
    const result = computeLegBasedPnL(position, [110, 4, undefined])!;

    // realized: closed short = (4 - 1.5) * 100 * 1 = 250
    expect(result.realized).toBeCloseTo(250);
    expect(result.perLeg.find(l => l.status === 'closed')?.realized).toBeCloseTo(250);
    // unrealized only for open legs (long mark=110, short mark=4)
    // long: (110-100)*100 = 1000; short: (5-4)*100 = 100
    expect(result.unrealized).toBeCloseTo(1100);
  });

  it('flags incomplete when an open leg has no mark', () => {
    const position: Position = {
      ...basePosition,
      legs: [
        { strike: 600, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 100, cycleQty: 1 },
      ],
    };
    const result = computeLegBasedPnL(position, [undefined])!;
    expect(result.complete).toBe(false);
    expect(result.unrealized).toBe(0);
  });

  it('flags incomplete when a leg is missing its fill price', () => {
    const position: Position = {
      ...basePosition,
      legs: [
        { strike: 600, type: 'Call', side: 'long', expiration: '2027-01-15', cycleQty: 1 },
      ],
    };
    const result = computeLegBasedPnL(position, [110])!;
    expect(result.complete).toBe(false);
    expect(result.unrealized).toBe(0);
  });

  it('handles BCD: long debit + short credit unrealized', () => {
    const position: Position = {
      ...basePosition,
      type: 'Debit Call Spread',
      legs: [
        { strike: 700, type: 'Call', side: 'long', expiration: '2026-06-19', openedDebit: 14, cycleQty: 1 },
        { strike: 740, type: 'Call', side: 'short', expiration: '2026-06-19', openedCredit: 0.5, cycleQty: 1 },
      ],
    };
    // current marks: long mid 17 (+3), short mid 0.4 (+0.1)
    const result = computeLegBasedPnL(position, [17, 0.4])!;
    // long unrealized = (17-14)*100 = 300
    // short unrealized = (0.5-0.4)*100 = 10
    expect(result.unrealized).toBeCloseTo(310);
    expect(result.realized).toBe(0);
  });
});

describe('isCycleRollTransaction', () => {
  it('detects PMCC roll markers', () => {
    expect(isCycleRollTransaction('PMCC roll: close short K=700 exp=2026-06-15')).toBe(true);
    expect(isCycleRollTransaction('PMCC roll: open short K=720 exp=2026-07-15')).toBe(true);
  });

  it('returns false for non-roll notes', () => {
    expect(isCycleRollTransaction('Open')).toBe(false);
    expect(isCycleRollTransaction('Take Profit')).toBe(false);
    expect(isCycleRollTransaction(undefined)).toBe(false);
    expect(isCycleRollTransaction(null)).toBe(false);
    expect(isCycleRollTransaction('')).toBe(false);
  });
});
