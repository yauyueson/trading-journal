import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ── Mock the I/O boundaries so the card renders without a backend ──────────────
// These let us mount PositionCard and exercise its live-quote fetch effect in
// isolation. The fetch stub is the system under test's only real dependency.
vi.mock('../../context/AppSettingsContext', () => ({
  useAppSettings: () => ({ settings: { portfolio: { accountSize: 100000 } }, stopOutFraction: 0.5 }),
}));

vi.mock('../../hooks/usePositionMutations', () => {
  const stub = () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false });
  return {
    usePositionAction: stub, useUpdatePrice: stub, useUpdateTarget: stub, useUpdateStop: stub,
    useUpdateOwner: stub, useUpdateNotes: stub, useDeletePosition: stub,
    useUpdateLeg: stub, useCloseLeg: stub,
  };
});

vi.mock('../../lib/greeksHistory', () => ({
  saveGreeksHistory: vi.fn(),
  fetchGreeksHistory: vi.fn().mockResolvedValue([]),
}));

// LegPanel pulls in LegRollModal / chain hooks — irrelevant to the header math.
vi.mock('../position/LegPanel', () => ({ LegPanel: () => null, legUnrealizedPnL: () => undefined }));

import { PositionCard } from '../PositionCard';
import type { Position, Transaction } from '../../lib/types';

// Per-leg quote bodies keyed by strike (mid = (bid+ask)/2 used for marks).
const QUOTES: Record<string, unknown> = {
  '630': { price: 130.28, bid: 130.0, ask: 130.56, delta: 0.78, gamma: 0.002, theta: -0.05, vega: 0.3, iv: 0.22, underlyingPrice: 600 },
  '756': { price: 2.32, bid: 2.2, ask: 2.44, delta: 0.22, gamma: 0.004, theta: -0.08, vega: 0.2, iv: 0.2, underlyingPrice: 600 },
};

let failingStrikes = new Set<string>();

const mkOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const mkErr = (status: number) => ({ ok: false, status, json: async () => ({ success: false, error: 'Option not found in chain' }) });

beforeEach(() => {
  failingStrikes = new Set();
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/earnings')) return mkOk({ hasUpcomingEarnings: false });
    const strike = new URLSearchParams(url.split('?')[1] ?? '').get('strike') ?? '';
    if (failingStrikes.has(strike)) return mkErr(404);
    return strike in QUOTES ? mkOk(QUOTES[strike]) : mkErr(404);
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

// Real QQQ PMCC: open long $630C @105.28, open short $756C @7.32, and a closed
// roll short $725C (exp 2026-06-12 — long expired) that realized +$175.
function pmccPosition(): Position {
  return {
    id: 'p1', ticker: 'QQQ', strike: 630, type: 'Call', expiration: '2027-01-15',
    status: 'active', setup: 'PMCC', entry_score: 0, current_score: 0,
    strategy_type: 'pmcc', is_paper: true, current_price: 118.74,
    legs: [
      { strike: 630, type: 'Call', side: 'long', expiration: '2027-01-15', openedDebit: 105.28, cycleQty: 1 },
      { strike: 756, type: 'Call', side: 'short', expiration: '2026-07-17', openedCredit: 7.32, cycleQty: 1 },
      { strike: 725, type: 'Call', side: 'short', expiration: '2026-06-12', openedCredit: 6.1, closedCost: 4.35, closedAt: '2026-06-05T18:00:00Z', cycleQty: 1 },
    ],
  };
}

const txns: Transaction[] = [
  { id: 't1', position_id: 'p1', date: '2026-05-07', type: 'Open', quantity: 1, price: 99.37, note: 'Paper autopilot entry' },
  { id: 't2', position_id: 'p1', date: '2026-06-05', type: 'Take Profit', quantity: 1, price: 4.35, note: 'Roll leg: close short K=725 exp=2026-06-12' },
  { id: 't3', position_id: 'p1', date: '2026-06-05', type: 'Take Profit', quantity: -1, price: 7.32, note: 'Roll leg: open short K=756 exp=2026-07-17' },
];

function renderCard() {
  return render(
    <PositionCard
      position={pmccPosition()}
      transactions={txns}
      fetchEarningsForTicker={async () => ({ daysUntil: null, date: null })}
    />,
  );
}

const requestedStrikes = () =>
  (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map(c => new URLSearchParams(String(c[0]).split('?')[1] ?? '').get('strike'))
    .filter(Boolean);

describe('PositionCard — PMCC live-quote fetch with a closed/expired leg', () => {
  it('regression: never quotes the closed/expired leg, shows live P&L (not "no live price")', async () => {
    // The expired closed $725 leg WOULD 404 — the card must not request it at all.
    failingStrikes = new Set(['725']);
    renderCard();

    // Net unrealized = long (130.28−105.28)·100 = 2500 + short (7.32−2.32)·100 = 500 = 3000.
    await waitFor(() => expect(screen.getByText('+$3.0K')).toBeInTheDocument());
    expect(screen.queryByText(/no live price/i)).toBeNull();
    expect(screen.getAllByText('+$175.00').length).toBeGreaterThan(0); // realized roll, unaffected

    const strikes = requestedStrikes();
    expect(strikes).toContain('630');
    expect(strikes).toContain('756');
    expect(strikes).not.toContain('725'); // the fix: closed leg is skipped
  });

  it('shows "no live price" when an OPEN leg quote is unavailable', async () => {
    failingStrikes = new Set(['630']); // long leg quote fails → cannot mark the net
    renderCard();
    await waitFor(() => expect(screen.getByText(/no live price/i)).toBeInTheDocument());
  });
});
