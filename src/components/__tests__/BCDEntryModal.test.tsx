import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ── Mock the I/O boundaries so the modal renders without a backend ────────────
// The modal only needs capital settings (for suggested qty), the add mutation,
// and the chain-candidate query. We stub the chain to empty so no "suggested
// spread" rows appear and the manual fields drive canSubmit / submitReason.
vi.mock('../../context/AppSettingsContext', () => ({
  useAppSettings: () => ({
    settings: { bcdCapital: { startingCapital: 5000, riskPctPerTrade: 30 } },
  }),
}));

vi.mock('../../hooks/usePositionMutations', () => ({
  useAddDirect: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false }),
}));

vi.mock('../../hooks/useChainCandidates', () => ({
  useChainCandidates: () => ({ data: [], isFetching: false, isError: false, dataUpdatedAt: 0 }),
}));

import { BCDEntryModal } from '../BCDEntryModal';

afterEach(() => vi.clearAllMocks());

const openBtn = () => screen.getByRole('button', { name: /OPEN BCD/i });
const dateInput = (c: HTMLElement) => c.querySelector('input[type="date"]') as HTMLInputElement;

describe('BCDEntryModal — disabled-submit hint', () => {
  it('explains the first unmet requirement instead of a silently dead button', () => {
    render(<BCDEntryModal isOpen onClose={vi.fn()} />);
    // Ticker defaults to QQQ, so the first gap is the (blank) expiration.
    expect(screen.getByText(/Choose an expiration date/i)).toBeInTheDocument();
    expect(openBtn()).toBeDisabled();
  });

  it('flags the reversed-strike trap (long must be below short for a bull call debit)', () => {
    const { container } = render(<BCDEntryModal isOpen onClose={vi.fn()} />);
    fireEvent.change(dateInput(container), { target: { value: '2026-08-21' } });
    // Long strike NOT below short strike → the exact trap the user hit.
    fireEvent.change(screen.getByPlaceholderText('e.g. 490'), { target: { value: '510' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 510'), { target: { value: '500' } });
    expect(screen.getByText(/Long strike must be below the short strike/i)).toBeInTheDocument();
    expect(openBtn()).toBeDisabled();
  });

  it('clears the hint and enables the button once every field is valid', () => {
    const { container } = render(<BCDEntryModal isOpen onClose={vi.fn()} />);
    fireEvent.change(dateInput(container), { target: { value: '2026-08-21' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 490'), { target: { value: '500' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 510'), { target: { value: '510' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 5.00'), { target: { value: '5.00' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 0.80'), { target: { value: '0.80' } });
    // No reason line, and the button is live — the definitive "not dead" signal.
    expect(screen.queryByText(/Long strike must be below|Choose an expiration/i)).not.toBeInTheDocument();
    expect(openBtn()).toBeEnabled();
  });
});
