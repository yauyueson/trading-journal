import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Position } from '../../lib/types';

const mocks = vi.hoisted(() => ({
  chain: [] as Array<Record<string, unknown>>,
  quote: { price: 1.20, bid: 1.15, ask: 1.25 },
  rollShort: vi.fn().mockResolvedValue(undefined),
  rollLeg: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../hooks/useChainCandidates', () => ({
  useChainCandidates: () => ({
    data: mocks.chain,
    isFetching: false,
    isError: false,
    dataUpdatedAt: Date.now(),
  }),
}));

vi.mock('../../hooks/useOptionQuote', () => ({
  useOptionQuote: () => ({
    data: mocks.quote,
    isFetching: false,
    isError: false,
  }),
}));

vi.mock('../../hooks/usePositionMutations', () => ({
  useRollPMCCShort: () => ({ mutateAsync: mocks.rollShort }),
  useRollLeg: () => ({ mutateAsync: mocks.rollLeg }),
}));

import { LegRollModal } from '../LegRollModal';
import { PMCCRollShortModal } from '../PMCCRollShortModal';

function option(strike: number, expiration: string, delta: number, bid: number) {
  return {
    strike,
    type: 'Call',
    expiration,
    dte: 35,
    price: bid + 0.05,
    greeks: { delta, gamma: 0.01, theta: -0.05, vega: 0.2, iv: 0.25 },
    liquidity: { volume: 100, openInterest: 500, bid, ask: bid + 0.10 },
  };
}

function pmccPosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pmcc-1',
    ticker: 'QQQ',
    strike: 400,
    type: 'PMCC Diagonal',
    expiration: '2099-12-18',
    status: 'active',
    setup: 'PMCC',
    entry_score: 0,
    current_score: 0,
    strategy_type: 'pmcc',
    is_paper: false,
    legs: [
      { strike: 400, type: 'Call', side: 'long', expiration: '2099-12-18', openedDebit: 90, cycleQty: 1 },
      { strike: 430, type: 'Call', side: 'short', expiration: '2099-06-19', openedCredit: 3.50, cycleQty: 1 },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.chain = [];
  mocks.quote = { price: 1.20, bid: 1.15, ask: 1.25 };
  mocks.rollShort.mockResolvedValue(undefined);
  mocks.rollLeg.mockResolvedValue(undefined);
});

describe('PMCC roll defaults', () => {
  it('auto-fills the current ask and the recommended new short bid', async () => {
    mocks.chain = [option(445, '2099-07-17', 0.25, 2.10)];
    render(<PMCCRollShortModal position={pmccPosition()} isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Close cost')).toHaveValue(1.25);
      expect(screen.getByLabelText('New expiration')).toHaveValue('2099-07-17');
      expect(screen.getByLabelText('New strike')).toHaveValue(445);
      expect(screen.getByLabelText('New credit')).toHaveValue(2.1);
    });

    fireEvent.click(screen.getByRole('button', { name: /confirm roll/i }));
    await waitFor(() => expect(mocks.rollShort).toHaveBeenCalledWith(expect.objectContaining({
      closeCost: 1.25,
      newExpiration: '2099-07-17',
      newStrike: 445,
      newCredit: 2.10,
    })));
  });

  it('offers and auto-selects an out-only reset when no higher strike is available', async () => {
    mocks.chain = [option(440, '2099-07-17', 0.25, 2.40)];
    const position = pmccPosition({
      legs: [
        { strike: 400, type: 'Call', side: 'long', expiration: '2099-12-18', openedDebit: 90, cycleQty: 1 },
        { strike: 470, type: 'Call', side: 'short', expiration: '2099-06-19', openedCredit: 1.20, cycleQty: 1 },
      ],
    });

    render(<PMCCRollShortModal position={position} isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText('New strike')).toHaveValue(440));
    expect(screen.getByText(/No higher strike was returned in-band/i)).toBeInTheDocument();
  });

  it('applies the same automatic defaults from the per-leg Roll action', async () => {
    mocks.chain = [option(445, '2099-07-17', 0.25, 2.10)];
    const position = pmccPosition();
    render(<LegRollModal position={position} legIndex={1} isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Close debit (per share)')).toHaveValue(1.25);
      expect(screen.getByLabelText('New expiration')).toHaveValue('2099-07-17');
      expect(screen.getByLabelText('New strike')).toHaveValue(445);
      expect(screen.getByLabelText('New credit (per share)')).toHaveValue(2.1);
    });

    fireEvent.click(screen.getByRole('button', { name: /confirm roll/i }));
    await waitFor(() => expect(mocks.rollLeg).toHaveBeenCalledWith(expect.objectContaining({
      legIndex: 1,
      closeFill: 1.25,
      newExpiration: '2099-07-17',
      newStrike: 445,
      newFill: 2.10,
    })));
  });
});
