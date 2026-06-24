import { describe, it, expect } from 'vitest';
import { computeDiagonalHeadline, computeNetSpreadPrice, computeLegBasedHeadlinePnL, computeLegBasedPnL, isCycleRollTransaction, filterCycleRolls, computeLivePnL } from '../legPnL';
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

describe('computeLegBasedHeadlinePnL', () => {
  it('uses open leg marks plus closed roll realized P&L for rolled PMCC headline accounting', () => {
    const position: Position = {
      ...basePosition,
      strategy_type: 'pmcc',
      legs: [
        { strike: 630, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 105.28, cycleQty: 1 },
        { strike: 756, type: 'Call', side: 'short', expiration: '2026-07-17', openedCredit: 7.32, cycleQty: 1 },
        { strike: 725, type: 'Call', side: 'short', expiration: '2026-06-12', openedCredit: 6.10, closedCost: 4.35, closedAt: '2026-06-05T18:00:00Z', cycleQty: 1 },
      ],
    };

    const result = computeLegBasedHeadlinePnL(position, [123.28, 7.315, undefined]);

    expect(result).not.toBeNull();
    expect(result!.unrealized).toBeCloseTo(1800.5);
    expect(result!.realized).toBeCloseTo(175);
    expect(result!.longUnrealized).toBeCloseTo(1800);
    expect(result!.basis).toBeCloseTo(10528);
    expect(result!.unrealizedPct).toBeCloseTo(17.10, 2);
  });
});

describe('computeDiagonalHeadline', () => {
  // Real QQQ PMCC paper position: long $630C @105.28, active short $756C @7.32,
  // closed roll short $725C (6.10 → 4.35 = +175 realized).
  const realPmcc: Position = {
    ...basePosition,
    strategy_type: 'pmcc',
    legs: [
      { strike: 630, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 105.28, cycleQty: 1 },
      { strike: 756, type: 'Call', side: 'short', expiration: '2026-07-17', openedCredit: 7.32, cycleQty: 1 },
      { strike: 725, type: 'Call', side: 'short', expiration: '2026-06-12', openedCredit: 6.10, closedCost: 4.35, closedAt: '2026-06-05T18:00:00Z', cycleQty: 1 },
    ],
  };

  it('known: true with full leg-aware numbers when every open leg has a mark', () => {
    const h = computeDiagonalHeadline(realPmcc, [123.28, 7.315, undefined]);
    expect(h.known).toBe(true);
    expect(h.unrealized).toBeCloseTo(1800.5);
    expect(h.longUnrealized).toBeCloseTo(1800);
    expect(h.basis).toBeCloseTo(10528);
    expect(h.unrealizedPct).toBeCloseTo(17.10, 2);
    expect(h.realized).toBeCloseTo(175);
  });

  it('known: false when NO live marks are available (the bug scenario) — realized still valid', () => {
    const h = computeDiagonalHeadline(realPmcc, []);
    expect(h.known).toBe(false);
    // Must NOT fabricate the legacy +128.96% / +$6.7K headline.
    expect(h.unrealized).toBe(0);
    expect(h.unrealizedPct).toBe(0);
    expect(h.longUnrealized).toBe(0);
    expect(h.basis).toBe(0);
    // Closed-cycle realized needs no mark, so it survives.
    expect(h.realized).toBeCloseTo(175);
  });

  it('known: false when only the short leg is missing a mark (cannot value the net)', () => {
    const h = computeDiagonalHeadline(realPmcc, [123.28, undefined, undefined]);
    expect(h.known).toBe(false);
    expect(h.unrealized).toBe(0);
    expect(h.realized).toBeCloseTo(175);
  });
});

describe('computeNetSpreadPrice', () => {
  const bcd: Position = {
    ...basePosition,
    type: 'Debit Call Spread',
    strategy_type: 'bcd',
    legs: [
      { strike: 741, type: 'Call', side: 'long', expiration: '2026-07-02', openedDebit: 18.48, cycleQty: 1 },
      { strike: 780, type: 'Call', side: 'short', expiration: '2026-07-02', openedCredit: 4.73, cycleQty: 1 },
    ],
  };

  it('BCD: entry = long debit − short credit; current = long mark − short mark', () => {
    const net = computeNetSpreadPrice(bcd, [4.09, 0.14]);
    expect(net.entry).toBeCloseTo(13.75); // 18.48 − 4.73
    expect(net.current).toBeCloseTo(3.95); // 4.09 − 0.14
  });

  it('current is null when any open leg lacks a mark; entry still resolves', () => {
    const net = computeNetSpreadPrice(bcd, [4.09]); // short mark missing
    expect(net.entry).toBeCloseTo(13.75);
    expect(net.current).toBeNull();
  });

  it('PMCC: ignores the closed rolled short leg', () => {
    const pmcc: Position = {
      ...basePosition,
      strategy_type: 'pmcc',
      legs: [
        { strike: 630, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 105.28, cycleQty: 1 },
        { strike: 756, type: 'Call', side: 'short', expiration: '2026-07-17', openedCredit: 7.32, cycleQty: 1 },
        { strike: 725, type: 'Call', side: 'short', expiration: '2026-06-12', openedCredit: 6.1, closedCost: 4.35, closedAt: '2026-06-05T18:00:00Z', cycleQty: 1 },
      ],
    };
    const net = computeNetSpreadPrice(pmcc, [123.28, 7.315, undefined]);
    expect(net.entry).toBeCloseTo(97.96); // 105.28 − 7.32 (closed leg excluded)
    expect(net.current).toBeCloseTo(115.965); // 123.28 − 7.315
  });
});

describe('filterCycleRolls + computeLivePnL', () => {
  it('filterCycleRolls drops PMCC roll transactions only', () => {
    const txns = [
      { quantity: 1, price: 100, note: 'Open' },
      { quantity: 1, price: 1.5, note: 'PMCC roll: close short K=700 exp=2026-06-15' },
      { quantity: -1, price: 4, note: 'PMCC roll: open short K=720 exp=2026-07-15' },
      { quantity: -1, price: 110, note: 'Take Profit' },
    ];
    const filtered = filterCycleRolls(txns);
    expect(filtered).toHaveLength(2);
    expect(filtered[0].note).toBe('Open');
    expect(filtered[1].note).toBe('Take Profit');
  });

  it('computeLivePnL sums cash flow excluding rolls and adds cycle realized', () => {
    const position: Position = {
      ...basePosition,
      legs: [
        { strike: 600, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 100, cycleQty: 1 },
        { strike: 720, type: 'Call', side: 'short', expiration: '2026-07-15', openedCredit: 5, cycleQty: 1 },
        { strike: 700, type: 'Call', side: 'short', expiration: '2026-06-15', openedCredit: 4, closedCost: 1.5, closedAt: '2026-05-15T20:00:00Z', cycleQty: 1 },
      ],
    };
    // Position-level transactions: original Open at $99 net debit + roll pair
    const txns = [
      { quantity: 1, price: 99, note: 'Open' },
      { quantity: 1, price: 1.5, note: 'PMCC roll: close short K=700 exp=2026-06-15' },
      { quantity: -1, price: 5, note: 'PMCC roll: open short K=720 exp=2026-07-15' },
    ];
    // For diagonal kind (treated as debit): cashFlow = proceeds − cost (excluding rolls)
    //   filtered = [Open at 99]; cost = 1*99*100 = 9900; proceeds = 0; cashFlow = -9900
    // cycleRealized: closed short = (4 - 1.5)*100 = 250
    // Total = -9900 + 250 = -9650
    const live = computeLivePnL(position, txns, false);
    expect(live).toBeCloseTo(-9650);
  });

  it('computeLivePnL handles a credit-strategy entry without rolls (legacy DTE5 case)', () => {
    const position: Position = {
      ...basePosition,
      type: 'Credit Put Spread',
      legs: undefined,
    };
    const txns = [{ quantity: 1, price: 1.5, note: 'Open' }];
    // For credit kind: cost - proceeds = 150 - 0 = +150 (banked credit)
    expect(computeLivePnL(position, txns, true)).toBeCloseTo(150);
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
