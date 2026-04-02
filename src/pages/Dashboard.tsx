import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppSettings } from '../context/AppSettingsContext';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';
import { useAddDirect, usePositionAction, useUpdatePrice } from '../hooks/usePositionMutations';
import { PositionCard } from '../components/PositionCard';
import { useSignalStatus } from '../hooks/useSignalStatus';
import type { Position, Transaction, PositionAction as PositionActionType, SpreadRecommendation } from '../lib/types';
import { CONTRACT_MULTIPLIER } from '../lib/utils';

// ────────────────────────────────────────────────────────────────
// State Machine
// ────────────────────────────────────────────────────────────────

type DashboardState = 'SIGNAL_ENTRY' | 'SIGNAL_HOLDING' | 'NO_SIGNAL_HOLDING' | 'WAITING';

function deriveState(signalActive: boolean, hasPosition: boolean): DashboardState {
  if (signalActive && !hasPosition) return 'SIGNAL_ENTRY';
  if (signalActive && hasPosition) return 'SIGNAL_HOLDING';
  if (!signalActive && hasPosition) return 'NO_SIGNAL_HOLDING';
  return 'WAITING';
}

// ────────────────────────────────────────────────────────────────
// Signal Card
// ────────────────────────────────────────────────────────────────

function SignalCard({ isActive, streak, lastSignalDate, asOfDate }: {
  isActive: boolean;
  streak: number;
  lastSignalDate: string | null;
  asOfDate: string | null;
}) {
  if (isActive) {
    return (
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-2 h-2 rounded-full bg-accent-green pulse" />
          <span className="text-accent-green font-semibold text-sm">QQQ Bull Signal Active</span>
          {streak > 1 && <span className="badge badge-green">Day {streak}</span>}
        </div>
        <p className="text-text-tertiary text-xs">Best entry: 10:00-10:30 AM</p>
        {asOfDate && <p className="text-text-tertiary text-[10px] mt-1">As of {asOfDate} close</p>}
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-2 h-2 rounded-full bg-text-tertiary" />
        <span className="text-text-secondary font-semibold text-sm">No Signal — QQQ Below EMA34</span>
      </div>
      <p className="text-text-tertiary text-xs">
        {lastSignalDate ? `Last signal: ${lastSignalDate}` : 'Waiting for signal...'}
      </p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Spread Recommendation Card
// ────────────────────────────────────────────────────────────────

function SpreadCard({ spread, contracts, maxProfit, maxLoss, riskPct, onClick }: {
  spread: SpreadRecommendation;
  contracts: number;
  maxProfit: number;
  maxLoss: number;
  riskPct: string;
  onClick: () => void;
}) {
  const credit = spread.netCredit ?? 0;
  const dte = spread.shortLeg.dte;

  return (
    <div
      className="card p-4 cursor-pointer hover:border-accent-blue/50 transition-colors"
      onClick={onClick}
    >
      <div className="flex justify-between items-start mb-2">
        <div>
          <span className="text-text-primary font-semibold text-sm">
            {spread.shortLeg.strike}/{spread.longLeg.strike} put
          </span>
          <span className="text-text-tertiary text-xs ml-2">{dte}d</span>
        </div>
        <span className="text-accent-green font-mono text-sm">${credit.toFixed(2)}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <span className="metric-label">Contracts</span>
          <div className="metric-value">{contracts}</div>
        </div>
        <div>
          <span className="metric-label">Max Profit</span>
          <div className="metric-value text-accent-green">${maxProfit.toFixed(0)}</div>
        </div>
        <div>
          <span className="metric-label">Risk</span>
          <div className="metric-value">${maxLoss.toFixed(0)} ({riskPct}%)</div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Confirm Modal
// ────────────────────────────────────────────────────────────────

function ConfirmModal({ spread, contracts, maxLoss, onConfirm, onCancel, isPending }: {
  spread: SpreadRecommendation;
  contracts: number;
  maxLoss: number;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const credit = spread.netCredit ?? 0;
  const maxProfit = credit * contracts * CONTRACT_MULTIPLIER;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-overlay" onClick={onCancel}>
      <div className="card p-5 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="text-text-primary font-semibold text-base mb-4">Confirm Position</h3>

        <div className="space-y-3 mb-5">
          <div className="flex justify-between">
            <span className="text-text-tertiary text-sm">Spread</span>
            <span className="text-text-primary font-mono text-sm">
              {spread.shortLeg.strike}/{spread.longLeg.strike} put
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary text-sm">Expiration</span>
            <span className="text-text-primary font-mono text-sm">{spread.shortLeg.expiration}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary text-sm">Contracts</span>
            <span className="text-text-primary font-mono text-sm">{contracts}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary text-sm">Credit</span>
            <span className="text-accent-green font-mono text-sm">${credit.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary text-sm">Max Profit</span>
            <span className="text-accent-green font-mono text-sm">${maxProfit.toFixed(0)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary text-sm">Max Risk</span>
            <span className="text-accent-red font-mono text-sm">${maxLoss.toFixed(0)}</span>
          </div>
        </div>

        <div className="flex gap-2">
          <button className="action-btn btn-secondary" onClick={onCancel} disabled={isPending}>
            Cancel
          </button>
          <button className="action-btn btn-primary" onClick={onConfirm} disabled={isPending}>
            {isPending ? 'Logging...' : 'Log Position'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Expiry Countdown
// ────────────────────────────────────────────────────────────────

function ExpiryCountdown({ expiration }: { expiration: string }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const expiryDate = useMemo(() => {
    const [y, m, d] = expiration.split('-').map(Number);
    // Market close on expiry day: 4:00 PM ET = 20:00 UTC (EST) or 21:00 UTC (EDT)
    return new Date(Date.UTC(y, m - 1, d, 21, 0, 0));
  }, [expiration]);

  const msLeft = Math.max(0, expiryDate.getTime() - now);
  const totalHours = msLeft / (1000 * 60 * 60);
  const daysLeft = Math.floor(totalHours / 24);
  const hoursLeft = Math.floor(totalHours % 24);

  // Progress: assume DTE5 = 5 trading days max
  const totalMs = 5 * 24 * 60 * 60 * 1000;
  const elapsed = totalMs - msLeft;
  const progress = Math.min(100, Math.max(0, (elapsed / totalMs) * 100));

  return (
    <div className="card p-4">
      <div className="flex justify-between items-center mb-2">
        <span className="metric-label">Expiry Countdown</span>
        <span className="text-xs font-semibold text-text-primary">{daysLeft}d {hoursLeft}h left</span>
      </div>
      <div className="w-full bg-bg-tertiary rounded-full h-2">
        <div
          className="h-2 rounded-full bg-accent-blue transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="text-text-tertiary text-[10px] mt-1">Expires {expiration}</p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Performance Summary
// ────────────────────────────────────────────────────────────────

function PerformanceSummary({ positions, transactions }: {
  positions: Position[];
  transactions: Transaction[];
}) {
  const stats = useMemo(() => {
    const closedDte5 = positions.filter(
      p => p.strategy_type === 'dte5' && p.status === 'closed'
    );
    if (closedDte5.length === 0) {
      return { totalPnl: 0, winRate: 0, trades: 0, avgCredit: 0 };
    }

    let wins = 0;
    let totalPnl = 0;
    let totalCredit = 0;

    for (const pos of closedDte5) {
      const posTxns = transactions.filter(t => t.position_id === pos.id);
      const opens = posTxns.filter(t => t.type === 'Open');
      const closes = posTxns.filter(t => t.type === 'Close' || t.type === 'Take Profit');

      const openValue = opens.reduce((s, t) => s + t.price * t.quantity * CONTRACT_MULTIPLIER, 0);
      const closeValue = closes.reduce((s, t) => s + t.price * t.quantity * CONTRACT_MULTIPLIER, 0);

      // Credit spread: open credit - close debit = P&L
      const pnl = openValue - closeValue;
      totalPnl += pnl;
      if (pnl > 0) wins++;

      if (opens.length > 0) {
        totalCredit += opens[0].price;
      }
    }

    return {
      totalPnl,
      winRate: closedDte5.length > 0 ? Math.round((wins / closedDte5.length) * 100) : 0,
      trades: closedDte5.length,
      avgCredit: closedDte5.length > 0 ? totalCredit / closedDte5.length : 0,
    };
  }, [positions, transactions]);

  return (
    <div className="stat-card">
      <h3 className="stat-label">DTE5 Performance</h3>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <div className="stat-label">Total P&L</div>
          <div className={`stat-value ${stats.totalPnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
            ${stats.totalPnl.toFixed(0)}
          </div>
        </div>
        <div>
          <div className="stat-label">Win Rate</div>
          <div className="stat-value">{stats.winRate}%</div>
        </div>
        <div>
          <div className="stat-label">Trades</div>
          <div className="metric-value">{stats.trades}</div>
        </div>
        <div>
          <div className="stat-label">Avg Credit</div>
          <div className="metric-value">${stats.avgCredit.toFixed(2)}</div>
        </div>
      </div>
      <div className="border-t border-border-default pt-3">
        <div className="stat-label">Backtest Reference</div>
        <div className="flex gap-4 text-[11px] text-text-tertiary">
          <span>WR 80%</span>
          <span>Sharpe 1.18</span>
          <span>CAGR 38.8%</span>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Main Dashboard Page
// ────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { settings } = useAppSettings();
  const { data: positions = [] } = usePositions();
  const { data: transactions = [] } = useTransactions();
  const { data: signal } = useSignalStatus('QQQ');
  const addDirect = useAddDirect();
  const positionAction = usePositionAction();
  const updatePrice = useUpdatePrice();

  const [selectedSpread, setSelectedSpread] = useState<SpreadRecommendation | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // Capital settings
  const capital = settings.dte5Capital?.startingCapital ?? 10000;
  const riskPctPerTrade = settings.dte5Capital?.riskPctPerTrade ?? 10;
  const maxRiskDollars = capital * (riskPctPerTrade / 100);

  // Find active DTE5 position
  const activeDte5 = useMemo(
    () => positions.find(p => p.strategy_type === 'dte5' && p.status === 'active') ?? null,
    [positions]
  );

  const signalActive = signal?.isActive ?? false;
  const dashboardState = deriveState(signalActive, !!activeDte5);

  // Fetch spread recommendations when signal is active and no position
  const spreadsQuery = useQuery<SpreadRecommendation[]>({
    queryKey: ['dashboard-spreads', 'QQQ'],
    queryFn: async () => {
      const params = new URLSearchParams({
        ticker: 'QQQ',
        direction: 'put',
        dteMin: String(settings.creditSpread?.dte5?.dteMin ?? 2),
        dteMax: String(settings.creditSpread?.dte5?.dteMax ?? 7),
        minDelta: '0.15',
        maxDelta: '0.35',
        strategy: 'credit',
      });
      const res = await fetch(`/api/scan-options?${params}`);
      if (!res.ok) throw new Error('Failed to fetch spreads');
      const json = await res.json();
      // strategy-recommend returns { strategies: { TARGET_STRATEGY: [...] } }
      // scan-options returns { results: [...] } or top-level array
      const spreads = json.strategies?.TARGET_STRATEGY ?? json.results ?? json ?? [];
      return (spreads as SpreadRecommendation[]).slice(0, 5);
    },
    enabled: dashboardState === 'SIGNAL_ENTRY',
    staleTime: 2 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  // Compute contracts and risk for a spread
  const computeSize = useCallback((spread: SpreadRecommendation) => {
    const maxRisk = spread.maxRisk;
    const riskPerContract = maxRisk * CONTRACT_MULTIPLIER;
    const contracts = riskPerContract > 0 ? Math.max(1, Math.floor(maxRiskDollars / riskPerContract)) : 1;
    const maxLoss = contracts * riskPerContract;
    const credit = spread.netCredit ?? 0;
    const maxProfit = credit * contracts * CONTRACT_MULTIPLIER;
    const riskPct = capital > 0 ? ((maxLoss / capital) * 100).toFixed(1) : '0';
    return { contracts, maxLoss, maxProfit, riskPct };
  }, [maxRiskDollars, capital]);

  // Handle spread click
  const handleSpreadClick = useCallback((spread: SpreadRecommendation) => {
    setSelectedSpread(spread);
    setShowConfirm(true);
  }, []);

  // Confirm and log position
  const handleConfirm = useCallback(async () => {
    if (!selectedSpread) return;
    const { contracts, maxLoss } = computeSize(selectedSpread);
    const credit = selectedSpread.netCredit ?? 0;

    await addDirect.mutateAsync({
      ticker: 'QQQ',
      strike: selectedSpread.shortLeg.strike,
      type: 'Put Spread',
      expiration: selectedSpread.shortLeg.expiration,
      setup: 'DTE5 Bull Put',
      strategy: 'Bull Put Spread',
      strategy_type: 'dte5',
      direction: 'BULL',
      entry_score: selectedSpread.score ?? 0,
      entry_price: credit,
      quantity: contracts,
      spread_width: selectedSpread.width,
      max_risk_entry: maxLoss,
      is_paper: true,
      target_price: 1.0,
      legs: [
        {
          strike: selectedSpread.shortLeg.strike,
          type: 'Put',
          side: 'short' as const,
          expiration: selectedSpread.shortLeg.expiration,
        },
        {
          strike: selectedSpread.longLeg.strike,
          type: 'Put',
          side: 'long' as const,
          expiration: selectedSpread.longLeg.expiration,
        },
      ],
    });

    setShowConfirm(false);
    setSelectedSpread(null);
  }, [selectedSpread, computeSize, addDirect]);

  // Action handlers for PositionCard
  const handleAction = useCallback(
    async (id: string, action: PositionActionType, exitType?: Position['exit_type']) => {
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

  // Transactions for active position
  const activeTxns = useMemo(
    () => activeDte5 ? transactions.filter(t => t.position_id === activeDte5.id) : [],
    [activeDte5, transactions]
  );

  return (
    <div className="fade-in space-y-6">
      {/* Header */}
      <div>
        <h1 className="page-header">Mission Control</h1>
        <p className="page-subtitle">QQQ DTE5 Bull Put Spread</p>
      </div>

      {/* Two-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Action */}
        <div className="space-y-4">
          {/* Signal card */}
          <SignalCard
            isActive={signalActive}
            streak={signal?.streak ?? 0}
            lastSignalDate={signal?.lastSignalDate ?? null}
            asOfDate={signal?.asOfDate ?? null}
          />

          {/* State-specific content */}
          {dashboardState === 'SIGNAL_ENTRY' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-text-primary font-semibold text-sm">Recommended Spreads</h2>
                <span className="text-text-tertiary text-[10px]">
                  Risk budget: ${maxRiskDollars.toFixed(0)} ({riskPctPerTrade}%)
                </span>
              </div>
              {spreadsQuery.isLoading && (
                <div className="card p-6 text-center">
                  <div className="spinner mx-auto mb-2" />
                  <p className="text-text-tertiary text-xs">Scanning spreads...</p>
                </div>
              )}
              {spreadsQuery.isError && (
                <div className="card p-4">
                  <p className="text-accent-red text-xs">Failed to load spreads. Try again later.</p>
                </div>
              )}
              {spreadsQuery.data && spreadsQuery.data.length === 0 && (
                <div className="card p-4">
                  <p className="text-text-tertiary text-xs">No qualifying spreads found in DTE 2-7 window.</p>
                </div>
              )}
              {spreadsQuery.data?.map((spread, i) => {
                const { contracts, maxProfit, maxLoss, riskPct } = computeSize(spread);
                return (
                  <SpreadCard
                    key={`${spread.shortLeg.strike}-${spread.longLeg.strike}-${i}`}
                    spread={spread}
                    contracts={contracts}
                    maxProfit={maxProfit}
                    maxLoss={maxLoss}
                    riskPct={riskPct}
                    onClick={() => handleSpreadClick(spread)}
                  />
                );
              })}
            </div>
          )}

          {dashboardState === 'SIGNAL_HOLDING' && (
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full bg-accent-blue" />
                <span className="text-accent-blue font-semibold text-sm">Holding — Signal Confirms</span>
              </div>
              <p className="text-text-tertiary text-xs">
                Signal active. Hold to expiry per strategy rules.
              </p>
            </div>
          )}

          {dashboardState === 'NO_SIGNAL_HOLDING' && (
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full bg-accent-yellow" />
                <span className="text-accent-yellow font-semibold text-sm">Signal Lost — Position Open</span>
              </div>
              <p className="text-text-tertiary text-xs">
                EMA34 gate failed. Hold to expiry (DTE5 strategy does not exit early on signal loss).
              </p>
            </div>
          )}

          {dashboardState === 'WAITING' && (
            <div className="card p-4">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 rounded-full bg-text-tertiary" />
                <span className="text-text-secondary font-semibold text-sm">Waiting for Entry</span>
              </div>
              <p className="text-text-tertiary text-xs">
                No active signal and no position. Check back after 9:00 PM UTC for next signal update.
              </p>
            </div>
          )}
        </div>

        {/* Right: Monitor */}
        <div className="space-y-4">
          {activeDte5 ? (
            <>
              <PositionCard
                position={activeDte5}
                transactions={activeTxns}
                onAction={handleAction}
                onUpdatePrice={handleUpdatePrice}
              />
              {activeDte5.expiration && (
                <ExpiryCountdown expiration={activeDte5.expiration} />
              )}
            </>
          ) : (
            <PerformanceSummary positions={positions} transactions={transactions} />
          )}
        </div>
      </div>

      {/* Confirm Modal */}
      {showConfirm && selectedSpread && (
        <ConfirmModal
          spread={selectedSpread}
          contracts={computeSize(selectedSpread).contracts}
          maxLoss={computeSize(selectedSpread).maxLoss}
          onConfirm={handleConfirm}
          onCancel={() => { setShowConfirm(false); setSelectedSpread(null); }}
          isPending={addDirect.isPending}
        />
      )}
    </div>
  );
}
