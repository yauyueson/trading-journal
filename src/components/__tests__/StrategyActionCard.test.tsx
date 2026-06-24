import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StrategyActionCard } from '../StrategyActionCard';
import { STRATEGY_PROFILES } from '../../lib/strategyProfiles';
import type { StrategyStatus } from '../../hooks/useStrategyStatus';
import type { Position, Transaction } from '../../lib/types';

const basePosition: Omit<Position, 'strategy_type' | 'legs'> = {
  id: 'p1',
  ticker: 'QQQ',
  strike: 630,
  type: 'Call',
  expiration: '2027-01-15',
  status: 'active',
  setup: 'PMCC',
  entry_score: 0,
  current_score: 0,
  created_at: '2026-05-07T19:27:15Z',
};

describe('StrategyActionCard — open-position P&L without live marks', () => {
  it('PMCC: shows realized-to-date, NOT the cash-flow phantom loss', () => {
    const position: Position = {
      ...basePosition,
      strategy_type: 'pmcc',
      legs: [
        { strike: 630, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 105.28, cycleQty: 1 },
        { strike: 756, type: 'Call', side: 'short', expiration: '2026-07-17', openedCredit: 7.32, cycleQty: 1 },
        { strike: 725, type: 'Call', side: 'short', expiration: '2026-06-12', openedCredit: 6.10, closedCost: 4.35, closedAt: '2026-06-05T18:00:00Z', cycleQty: 1 },
      ],
    };
    // These transactions would produce the −$9,762 cash-flow phantom under the
    // old code (long debit booked with no current value credited).
    const txns: Transaction[] = [
      { id: 't1', position_id: 'p1', date: '2026-05-07', type: 'Open', quantity: 1, price: 99.37, note: 'Paper autopilot entry' },
      { id: 't2', position_id: 'p1', date: '2026-06-05', type: 'Take Profit', quantity: 1, price: 4.35, note: 'Roll leg: close short K=725 exp=2026-06-12' },
      { id: 't3', position_id: 'p1', date: '2026-06-05', type: 'Take Profit', quantity: -1, price: 7.32, note: 'Roll leg: open short K=756 exp=2026-07-17' },
    ];
    const status: StrategyStatus = {
      strategy: 'pmcc',
      profile: STRATEGY_PROFILES.pmcc,
      openPosition: position,
      state: 'open',
      openSinceDate: '2026-05-07',
    };

    render(<StrategyActionCard status={status} positionTransactions={txns} onEnter={() => {}} />);

    expect(screen.getByText(/\+\$175\.00 realized/)).toBeInTheDocument();
    // The phantom cash-flow loss must NOT appear anywhere.
    expect(screen.queryByText(/9,?762/)).toBeNull();
  });

  it('BCD with no closed legs: shows "P&L —" rather than the entry debit as a loss', () => {
    const position: Position = {
      ...basePosition,
      setup: 'BCD',
      strategy_type: 'bcd',
      legs: [
        { strike: 700, type: 'Call', side: 'long', expiration: '2026-06-19', openedDebit: 14, cycleQty: 1 },
        { strike: 740, type: 'Call', side: 'short', expiration: '2026-06-19', openedCredit: 0.5, cycleQty: 1 },
      ],
    };
    const txns: Transaction[] = [
      { id: 't1', position_id: 'p1', date: '2026-05-07', type: 'Open', quantity: 1, price: 13.5, note: 'Open' },
    ];
    const status: StrategyStatus = {
      strategy: 'bcd',
      profile: STRATEGY_PROFILES.bcd,
      openPosition: position,
      state: 'open',
      openSinceDate: '2026-05-07',
    };

    render(<StrategyActionCard status={status} positionTransactions={txns} onEnter={() => {}} />);

    expect(screen.getByText(/P&L —/)).toBeInTheDocument();
  });
});
