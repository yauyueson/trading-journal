import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StrategyActionCard } from '../StrategyActionCard';
import { STRATEGY_PROFILES } from '../../lib/strategyProfiles';
import type { StrategyStatus } from '../../hooks/useStrategyStatus';
import type { Position, Transaction } from '../../lib/types';

/** Local YYYY-MM-DD exactly n days from today. */
function isoDaysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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

describe('StrategyActionCard — live spread price from leg marks', () => {
  // Real active BCD (2026-08-12): long 724C @18.50, short 757C @5.20 → entry net
  // debit 13.30. Live mids: long 3.45, short 0.01 → current net 3.44.
  const bcdPosition: Position = {
    ...basePosition,
    setup: 'BCD',
    strategy_type: 'bcd',
    expiration: '2026-08-14',
    legs: [
      { strike: 724, type: 'Call', side: 'long', expiration: '2026-08-14', openedDebit: 18.5, cycleQty: 1 },
      { strike: 757, type: 'Call', side: 'short', expiration: '2026-08-14', openedCredit: 5.2, cycleQty: 1 },
    ],
  };
  const bcdStatus: StrategyStatus = {
    strategy: 'bcd',
    profile: STRATEGY_PROFILES.bcd,
    openPosition: bcdPosition,
    state: 'open',
    openSinceDate: '2026-07-15',
  };

  it('BCD: shows entry → now net debit and the live unrealized P&L', () => {
    render(
      <StrategyActionCard
        status={bcdStatus}
        positionTransactions={[]}
        legMarks={[3.45, 0.01]}
        onEnter={() => {}}
      />,
    );

    // (3.45 − 18.50)·100 + (5.20 − 0.01)·100 = −1505 + 519 = −986.
    expect(screen.getByText(/−\$986\.00/)).toBeInTheDocument();
    expect(screen.getByText('$13.30')).toBeInTheDocument();
    expect(screen.getByText('$3.44')).toBeInTheDocument();
    expect(screen.queryByText(/P&L —/)).toBeNull();
  });

  it('BCD: falls back to "P&L —" when an open leg has no mark', () => {
    render(
      <StrategyActionCard
        status={bcdStatus}
        positionTransactions={[]}
        legMarks={[3.45, undefined]}
        onEnter={() => {}}
      />,
    );

    expect(screen.getByText(/P&L —/)).toBeInTheDocument();
    // Entry is known without marks, so it still shows — only "now" is unknown.
    expect(screen.getByText('$13.30')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('PMCC: shows live unrealized alongside realized roll cycles', () => {
    const position: Position = {
      ...basePosition,
      strategy_type: 'pmcc',
      legs: [
        { strike: 630, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 105.28, cycleQty: 1 },
        { strike: 732, type: 'Call', side: 'short', expiration: '2026-08-31', openedCredit: 6.46, cycleQty: 1 },
        { strike: 725, type: 'Call', side: 'short', expiration: '2026-06-12', openedCredit: 6.1, closedCost: 4.35, closedAt: '2026-06-05T18:00:00Z', cycleQty: 1 },
      ],
    };
    const status: StrategyStatus = {
      strategy: 'pmcc',
      profile: STRATEGY_PROFILES.pmcc,
      openPosition: position,
      state: 'open',
      openSinceDate: '2026-05-07',
    };

    render(
      <StrategyActionCard
        status={status}
        positionTransactions={[]}
        legMarks={[116.14, 8.06, undefined]}
        onEnter={() => {}}
      />,
    );

    // Unrealized: (116.14 − 105.28)·100 + (6.46 − 8.06)·100 = 1086 − 160 = 926.
    expect(screen.getByText(/\+\$926\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\+\$175\.00 realized/)).toBeInTheDocument();
    // Entry net 105.28 − 6.46 = 98.82; now 116.14 − 8.06 = 108.08.
    expect(screen.getByText('$98.82')).toBeInTheDocument();
    expect(screen.getByText('$108.08')).toBeInTheDocument();
  });
});

describe('StrategyActionCard — exit-proximity chip', () => {
  function bcdStatus(expDays: number, currentPrice: number): StrategyStatus {
    return {
      strategy: 'bcd',
      profile: STRATEGY_PROFILES.bcd,
      state: 'open',
      openSinceDate: '2026-06-12',
      openPosition: {
        ...basePosition,
        setup: 'BCD',
        strategy_type: 'bcd',
        expiration: isoDaysFromNow(expDays),
        current_price: currentPrice,
        legs: [
          { strike: 741, type: 'Call', side: 'long', expiration: isoDaysFromNow(expDays), openedDebit: 18.48, cycleQty: 1 },
          { strike: 780, type: 'Call', side: 'short', expiration: isoDaysFromNow(expDays), openedCredit: 4.73, cycleQty: 1 },
        ],
      } as Position,
    };
  }

  it('BCD nearing the 7-DTE time stop shows an "EXIT IN 2d" chip', () => {
    render(<StrategyActionCard status={bcdStatus(9, 3.95)} positionTransactions={[]} onEnter={() => {}} />);
    expect(screen.getByText('EXIT IN 2d')).toBeInTheDocument();
  });

  it('BCD at its TP target shows a "TP READY" chip', () => {
    render(<StrategyActionCard status={bcdStatus(40, 26.375)} positionTransactions={[]} onEnter={() => {}} />);
    expect(screen.getByText('TP READY')).toBeInTheDocument();
  });

  it('BCD far from any exit shows no chip', () => {
    render(<StrategyActionCard status={bcdStatus(40, 3.95)} positionTransactions={[]} onEnter={() => {}} />);
    expect(screen.queryByText(/EXIT IN|TIME STOP|TP /)).toBeNull();
  });
});
