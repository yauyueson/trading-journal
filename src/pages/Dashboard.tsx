import { useState, useMemo, useCallback } from 'react';
import { Clock, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { useSignalStatus } from '../hooks/useSignalStatus';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';
import { useAddDirect, usePositionAction, useUpdatePrice } from '../hooks/usePositionMutations';
import { useAppSettings } from '../context/AppSettingsContext';
import { SignalBadge } from '../components/dashboard/SignalBadge';
import { SpreadCard } from '../components/dashboard/SpreadCard';
import type { SpreadCandidate } from '../components/dashboard/SpreadCard';
import { ConfirmSpreadModal } from '../components/dashboard/ConfirmSpreadModal';
import { ExpiryCountdown } from '../components/dashboard/ExpiryCountdown';
import { PerformanceSummary } from '../components/dashboard/PerformanceSummary';
import { PositionCard } from '../components/PositionCard';
import type { Position } from '../lib/types';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
type DashboardState =
  | 'SIGNAL_ENTRY'    // signal active, no open DTE5 position
  | 'SIGNAL_HOLDING'  // signal active, open DTE5 position
  | 'NO_SIGNAL_HOLDING' // signal off, open DTE5 position
  | 'WAITING';        // signal off, no open DTE5 position

function deriveDashboardState(signalActive: boolean, hasPosition: boolean): DashboardState {
  if (signalActive && !hasPosition) return 'SIGNAL_ENTRY';
  if (signalActive && hasPosition) return 'SIGNAL_HOLDING';
  if (!signalActive && hasPosition) return 'NO_SIGNAL_HOLDING';
  return 'WAITING';
}

// ---------------------------------------------------------------------------
// Spread scanning helpers
// ---------------------------------------------------------------------------
interface ScanResult {
  strike: number;
  type: string;
  expiration: string;
  dte: number;
  price: number;          // mid
  greeks: { delta: number };
  liquidity: { bid: number; ask: number };
}

function buildSpreads(results: ScanResult[], equity: number): SpreadCandidate[] {
  // Filter to puts only
  const puts = results.filter(r => r.type === 'Put' || r.type === 'put');

  const candidates: SpreadCandidate[] = [];

  for (const short of puts) {
    const absDelta = Math.abs(short.greeks.delta);
    if (absDelta < 0.25 || absDelta > 0.35) continue;

    // Find long leg: same expiration, $5-$10 lower strike
    const longs = puts.filter(
      l =>
        l.expiration === short.expiration &&
        l.strike < short.strike &&
        short.strike - l.strike >= 5 &&
        short.strike - l.strike <= 10
    );

    for (const long of longs) {
      const width = short.strike - long.strike;
      const credit = short.price - long.price; // mid-based
      if (credit <= 0) continue;

      const maxLossPerContract = (width - credit) * 100;
      if (maxLossPerContract <= 0) continue;

      // Size at 10% risk
      const contracts = Math.max(1, Math.floor((equity * 0.10) / maxLossPerContract));
      const totalMaxLoss = maxLossPerContract * contracts;
      const totalMaxProfit = credit * 100 * contracts;

      candidates.push({
        shortStrike: short.strike,
        longStrike: long.strike,
        credit: Math.round(credit * 100) / 100,
        dte: short.dte,
        expiration: short.expiration,
        contracts,
        maxLoss: totalMaxLoss,
        maxProfit: totalMaxProfit,
        riskPct: equity > 0 ? (totalMaxLoss / equity) * 100 : 0,
        shortDelta: absDelta,
        pop: 1 - absDelta, // approximate POP
      });
    }
  }

  // Sort: closest to DTE 5 first, then highest credit
  candidates.sort((a, b) => {
    const dteDiffA = Math.abs(a.dte - 5);
    const dteDiffB = Math.abs(b.dte - 5);
    if (dteDiffA !== dteDiffB) return dteDiffA - dteDiffB;
    return b.credit - a.credit;
  });

  return candidates.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function DashboardPage() {
  const { data: signal, isLoading: signalLoading } = useSignalStatus('QQQ');
  const { data: positions = [], isLoading: positionsLoading } = usePositions();
  const { data: transactions = [], isLoading: txLoading } = useTransactions();
  const { settings } = useAppSettings();
  const addDirect = useAddDirect();
  const positionAction = usePositionAction();
  const updatePrice = useUpdatePrice();

  const [confirmSpread, setConfirmSpread] = useState<SpreadCandidate | null>(null);

  // Active DTE5 position (max 1 concurrent per strategy rules)
  const activeDte5 = useMemo(
    () => positions.find(p => p.status === 'active' && p.strategy_type === 'dte5'),
    [positions]
  );

  const activeDte5Transactions = useMemo(
    () => (activeDte5 ? transactions.filter(t => t.position_id === activeDte5.id) : []),
    [activeDte5, transactions]
  );

  // Derive state
  const signalActive = signal?.isActive ?? false;
  const hasPosition = !!activeDte5;
  const state = deriveDashboardState(signalActive, hasPosition);

  // Equity = account size from settings
  const equity = settings.portfolio.accountSize;

  // Spread scan query — only when SIGNAL_ENTRY
  const { data: spreads = [], isLoading: spreadsLoading } = useQuery<SpreadCandidate[]>({
    queryKey: ['dashboard-spreads', equity],
    queryFn: async () => {
      const url = `/api/scan-options?ticker=QQQ&direction=put&dteMin=2&dteMax=7&minDelta=0.15&maxDelta=0.35&strategy=credit`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Scan failed');
      const json = await res.json();
      if (!json.success || !json.results) return [];
      return buildSpreads(json.results as ScanResult[], equity);
    },
    enabled: state === 'SIGNAL_ENTRY',
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  // Handlers
  const handleConfirm = useCallback(
    async (spread: SpreadCandidate, adjustedCredit: number, adjustedContracts: number) => {
      const width = spread.shortStrike - spread.longStrike;
      await addDirect.mutateAsync({
        ticker: 'QQQ',
        strike: spread.shortStrike,
        type: 'Bull Put Spread',
        expiration: spread.expiration,
        setup: 'DTE5',
        strategy: 'Bull Put Spread',
        strategy_type: 'dte5',
        direction: 'BULL',
        entry_score: 50,
        entry_price: adjustedCredit,
        quantity: adjustedContracts,
        spread_width: width,
        max_risk_entry: (width - adjustedCredit) * 100 * adjustedContracts,
        is_paper: true,
        target_price: 0.01,
        legs: [
          { strike: spread.shortStrike, type: 'Put', side: 'short', expiration: spread.expiration },
          { strike: spread.longStrike, type: 'Put', side: 'long', expiration: spread.expiration },
        ],
      });
      setConfirmSpread(null);
    },
    [addDirect]
  );

  const handlePositionAction = useCallback(
    async (id: string, action: Parameters<typeof positionAction.mutateAsync>[0]['action'], exitType?: Position['exit_type']) => {
      await positionAction.mutateAsync({ id, action, exitType });
    },
    [positionAction]
  );

  const handleUpdatePrice = useCallback(
    async (id: string, price: number) => {
      await updatePrice.mutateAsync({ id, price });
    },
    [updatePrice]
  );

  // Loading state
  if (signalLoading || positionsLoading || txLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading dashboard...
      </div>
    );
  }

  // Entry date for countdown — from Open transaction
  const entryDate = activeDte5
    ? activeDte5Transactions.find(t => t.type === 'Open')?.date?.split('T')[0] ?? activeDte5.created_at?.split('T')[0] ?? ''
    : '';

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">Mission Control</h1>
        <p className="text-zinc-500 text-sm">QQQ DTE5 Bull Put Spread — Paper Trading</p>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT COLUMN — Action */}
        <div className="space-y-4">
          {/* Signal badge (always shown) */}
          <SignalBadge
            isActive={signalActive}
            streak={signal?.streak ?? 0}
            lastSignalDate={signal?.lastSignalDate ?? null}
            asOfDate={signal?.asOfDate ?? null}
          />

          {/* State-specific content */}
          {state === 'SIGNAL_ENTRY' && (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-zinc-300">Recommended Spreads</h2>
              {spreadsLoading ? (
                <div className="flex items-center gap-2 text-zinc-500 text-sm py-4">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Scanning for spreads...
                </div>
              ) : spreads.length > 0 ? (
                spreads.map(s => (
                  <SpreadCard key={`${s.shortStrike}-${s.longStrike}-${s.expiration}`} spread={s} onVerifyOpen={setConfirmSpread} />
                ))
              ) : (
                <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-4">
                  <p className="text-zinc-400 text-sm">No qualifying spreads found. Check back during market hours.</p>
                </div>
              )}
            </div>
          )}

          {state === 'SIGNAL_HOLDING' && (
            <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-4">
              <div className="flex items-center gap-2 mb-1">
                <ShieldCheck className="w-4 h-4 text-green-400" />
                <span className="text-green-400 font-semibold text-sm">Holding to Expiry</span>
              </div>
              <p className="text-zinc-400 text-xs">
                Signal remains active. Position will be held until expiration per strategy rules.
              </p>
            </div>
          )}

          {state === 'NO_SIGNAL_HOLDING' && (
            <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="w-4 h-4 text-yellow-400" />
                <span className="text-yellow-400 font-semibold text-sm">Signal Lost — Still Holding</span>
              </div>
              <p className="text-zinc-400 text-xs">
                EMA34 gate has turned off. Existing position held to expiry (no early exit per DTE5 rules).
              </p>
            </div>
          )}

          {state === 'WAITING' && (
            <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-4">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="w-4 h-4 text-zinc-500" />
                <span className="text-zinc-400 font-semibold text-sm">Waiting for Signal</span>
              </div>
              <p className="text-zinc-500 text-xs">
                QQQ is below EMA34. No new positions until the bull signal returns.
              </p>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN — Monitor */}
        <div className="space-y-4">
          {activeDte5 ? (
            <>
              {/* Position card */}
              <PositionCard
                position={activeDte5}
                transactions={activeDte5Transactions}
                onAction={handlePositionAction}
                onUpdatePrice={handleUpdatePrice}
              />

              {/* Expiry countdown */}
              {activeDte5.expiration && entryDate && (
                <ExpiryCountdown
                  expiration={activeDte5.expiration}
                  entryDate={entryDate}
                />
              )}
            </>
          ) : (
            /* Performance summary when idle */
            <PerformanceSummary positions={positions} transactions={transactions} />
          )}
        </div>
      </div>

      {/* Confirm modal */}
      {confirmSpread && (
        <ConfirmSpreadModal
          spread={confirmSpread}
          onConfirm={handleConfirm}
          onCancel={() => setConfirmSpread(null)}
        />
      )}
    </div>
  );
}
