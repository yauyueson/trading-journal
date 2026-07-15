import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mutateAsync } = vi.hoisted(() => ({
  mutateAsync: vi.fn().mockResolvedValue(undefined),
}));

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
  useAddDirect: () => ({ mutateAsync, isPending: false }),
}));

vi.mock('../../hooks/useChainCandidates', () => ({
  useChainCandidates: () => ({ data: [], isFetching: false, isError: false, dataUpdatedAt: 0 }),
}));

import { BCDEntryModal } from '../BCDEntryModal';

afterEach(() => {
  vi.clearAllMocks();
  mutateAsync.mockResolvedValue(undefined);
});

const openBtn = () => screen.getByRole('button', { name: /OPEN BCD/i });
const dateInput = (c: HTMLElement) => c.querySelector('input[type="date"]') as HTMLInputElement;

const fillValidSpread = (container: HTMLElement, longDebit = '5.00', shortCredit = '0.80') => {
  fireEvent.change(dateInput(container), { target: { value: '2026-08-21' } });
  fireEvent.change(screen.getByPlaceholderText('e.g. 490'), { target: { value: '500' } });
  fireEvent.change(screen.getByPlaceholderText('e.g. 510'), { target: { value: '510' } });
  fireEvent.change(screen.getByPlaceholderText('e.g. 5.00'), { target: { value: longDebit } });
  fireEvent.change(screen.getByPlaceholderText('e.g. 0.80'), { target: { value: shortCredit } });
};

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
    fillValidSpread(container);
    // No reason line, and the button is live — the definitive "not dead" signal.
    expect(screen.queryByText(/Long strike must be below|Choose an expiration/i)).not.toBeInTheDocument();
    expect(openBtn()).toBeEnabled();
  });

  it('bounds the tall form to the viewport and makes the modal panel scrollable', () => {
    render(<BCDEntryModal isOpen onClose={vi.fn()} />);

    expect(screen.getByTestId('bcd-entry-panel')).toHaveClass(
      'max-h-[100dvh]',
      'overflow-y-auto',
      'overscroll-contain',
    );
  });

  it('explains the screenshot risk-cap failure before submit', () => {
    const { container } = render(<BCDEntryModal isOpen onClose={vi.fn()} />);
    fillValidSpread(container, '20.25', '4.86');

    expect(screen.getByText(/Max loss \$1539 exceeds the \$1500 BCD risk cap/i)).toBeInTheDocument();
    expect(openBtn()).toBeDisabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('shows a persistence or governance error instead of failing silently', async () => {
    const onClose = vi.fn();
    mutateAsync.mockRejectedValueOnce(new Error(
      'Execution ticket blocked: strategy already has 1 active position(s); max is 1',
    ));
    const { container } = render(<BCDEntryModal isOpen onClose={onClose} />);
    fillValidSpread(container);

    fireEvent.click(openBtn());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      /Trade blocked: strategy already has 1 active position/i,
    ));
    expect(onClose).not.toHaveBeenCalled();
    expect(openBtn()).toBeEnabled();
  });

  it('opens a valid BCD position and closes the modal after persistence succeeds', async () => {
    const onClose = vi.fn();
    const { container } = render(<BCDEntryModal isOpen onClose={onClose} />);
    fillValidSpread(container);

    fireEvent.click(openBtn());

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledOnce());
    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      ticker: 'QQQ',
      strategy_type: 'bcd',
      entry_price: 4.2,
      quantity: 3,
      max_risk_entry: 420,
    }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
