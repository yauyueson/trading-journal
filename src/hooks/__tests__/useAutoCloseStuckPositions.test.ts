import { describe, it, expect } from 'vitest';
import { findStuckPositions } from '../useAutoCloseStuckPositions';

const pos = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, status: 'active', ticker: 'QQQ', ...extra }) as any;
const tx = (position_id: string, quantity: number, note?: string) =>
  ({ position_id, quantity, price: 1, note }) as any;

describe('findStuckPositions', () => {
  it('flags a single-leg position whose quantity was fully sold', () => {
    const stuck = findStuckPositions([pos('a')], [tx('a', 2), tx('a', -2, 'Take Profit')]);
    expect(stuck.map(p => p.id)).toEqual(['a']);
  });

  it('ignores positions that still have quantity', () => {
    expect(findStuckPositions([pos('a')], [tx('a', 2), tx('a', -1)])).toEqual([]);
  });

  it('never closes a spread that still has open legs (add-leg short makes Σqty = 0)', () => {
    const spread = pos('s', {
      legs: [
        { side: 'long', strike: 700, type: 'Call', expiration: '2026-12-18' },
        { side: 'short', strike: 740, type: 'Call', expiration: '2026-12-18' },
      ],
    });
    const stuck = findStuckPositions([spread], [tx('s', 1), tx('s', -1, 'Add leg: short Call K=740 exp=2026-12-18')]);
    expect(stuck).toEqual([]);
  });

  it('ignores leg-level roll / close txns in the sum', () => {
    const stuck = findStuckPositions(
      [pos('p')],
      [tx('p', 1), tx('p', -1, 'Close leg: long Call K=630 exp=2027-01-15')],
    );
    expect(stuck).toEqual([]);
  });

  it('skips non-active rows and rows without transactions', () => {
    expect(findStuckPositions([pos('c', { status: 'closed' }), pos('n')], [tx('c', 1), tx('c', -1)])).toEqual([]);
  });
});
