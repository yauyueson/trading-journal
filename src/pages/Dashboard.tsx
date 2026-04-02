import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAppSettings } from '../context/AppSettingsContext';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';
import { useAddDirect, usePositionAction, useUpdatePrice } from '../hooks/usePositionMutations';
import { PositionCard } from '../components/PositionCard';
import { useAllSignals } from '../hooks/useSignalStatus';
import type { Position, PositionAction as PositionActionType, SpreadRecommendation } from '../lib/types';
import { CONTRACT_MULTIPLIER } from '../lib/utils';

const DTE5_TICKERS = ['QQQ', 'SPY', 'IWM'];

// ────────────────────────────────────────────────────────────────
// Main Dashboard
// ────────────────────────────────────────────────────────────────

export function DashboardPage() {
  const { settings } = useAppSettings();
  const { data: positions = [] } = usePositions();
  const { data: transactions = [] } = useTransactions();
  const { data: allSignals = [] } = useAllSignals(DTE5_TICKERS);
  const addDirect = useAddDirect();
  const positionAction = usePositionAction();
  const updatePrice = useUpdatePrice();

  const [selectedSpread, setSelectedSpread] = useState<SpreadRecommendation | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // Capital settings
  const capital = settings.dte5Capital?.startingCapital ?? 10000;
  const riskPctPerTrade = settings.dte5Capital?.riskPctPerTrade ?? 10;
  const maxRiskDollars = capital * (riskPctPerTrade / 100);

  // Active positions (all strategies, sorted by expiration)
  const activePositions = useMemo(
    () => positions
      .filter(p => p.status === 'active')
      .sort((a, b) => (a.expiration ?? '').localeCompare(b.expiration ?? '')),
    [positions]
  );

  // Active DTE5 position specifically
  const activeDte5 = useMemo(
    () => positions.find(p => p.strategy_type === 'dte5' && p.status === 'active') ?? null,
    [positions]
  );

  // QQQ signal
  const qqSignal = allSignals.find(s => s.ticker === 'QQQ');
  const signalActive = qqSignal?.isActive ?? false;
  const canEnter = signalActive && !activeDte5;

  // Closed DTE5 stats
  const perfStats = useMemo(() => {
    const closed = positions.filter(p => p.strategy_type === 'dte5' && p.status === 'closed');
    if (closed.length === 0) return { pnl: 0, winRate: 0, trades: 0, avgCredit: 0 };
    let wins = 0, totalPnl = 0, totalCredit = 0;
    for (const pos of closed) {
      const txns = transactions.filter(t => t.position_id === pos.id);
      const opens = txns.filter(t => t.type === 'Open');
      const closes = txns.filter(t => t.type === 'Close' || t.type === 'Take Profit');
      const openVal = opens.reduce((s, t) => s + t.price * t.quantity * CONTRACT_MULTIPLIER, 0);
      const closeVal = closes.reduce((s, t) => s + t.price * t.quantity * CONTRACT_MULTIPLIER, 0);
      const pnl = openVal - closeVal;
      totalPnl += pnl;
      if (pnl > 0) wins++;
      if (opens.length > 0) totalCredit += opens[0].price;
    }
    return { pnl: totalPnl, winRate: Math.round((wins / closed.length) * 100), trades: closed.length, avgCredit: closed.length > 0 ? totalCredit / closed.length : 0 };
  }, [positions, transactions]);

  // Spread recommendations
  const spreadsQuery = useQuery<SpreadRecommendation[]>({
    queryKey: ['dashboard-spreads', 'QQQ'],
    queryFn: async () => {
      const params = new URLSearchParams({
        ticker: 'QQQ', direction: 'put',
        dteMin: String(settings.creditSpread?.dte5?.dteMin ?? 2),
        dteMax: String(settings.creditSpread?.dte5?.dteMax ?? 7),
        minDelta: '0.15', maxDelta: '0.35', strategy: 'credit',
      });
      const res = await fetch(`/api/scan-options?${params}`);
      if (!res.ok) throw new Error('Failed');
      const json = await res.json();
      const spreads = json.strategies?.TARGET_STRATEGY ?? json.results ?? json ?? [];
      return (spreads as SpreadRecommendation[]).slice(0, 3);
    },
    enabled: canEnter,
    staleTime: 2 * 60 * 1000,
  });

  const computeSize = useCallback((spread: SpreadRecommendation) => {
    const riskPerContract = spread.maxRisk * CONTRACT_MULTIPLIER;
    const contracts = riskPerContract > 0 ? Math.max(1, Math.floor(maxRiskDollars / riskPerContract)) : 1;
    const maxLoss = contracts * riskPerContract;
    const credit = spread.netCredit ?? 0;
    const maxProfit = credit * contracts * CONTRACT_MULTIPLIER;
    const riskPct = capital > 0 ? ((maxLoss / capital) * 100).toFixed(1) : '0';
    return { contracts, maxLoss, maxProfit, riskPct };
  }, [maxRiskDollars, capital]);

  const handleConfirm = useCallback(async () => {
    if (!selectedSpread) return;
    const { contracts, maxLoss } = computeSize(selectedSpread);
    const credit = selectedSpread.netCredit ?? 0;
    await addDirect.mutateAsync({
      ticker: 'QQQ', strike: selectedSpread.shortLeg.strike, type: 'Put Spread',
      expiration: selectedSpread.shortLeg.expiration, setup: 'DTE5 Bull Put',
      strategy: 'Bull Put Spread', strategy_type: 'dte5', direction: 'BULL',
      entry_score: selectedSpread.score ?? 0, entry_price: credit, quantity: contracts,
      spread_width: selectedSpread.width, max_risk_entry: maxLoss, is_paper: true, target_price: 1.0,
      legs: [
        { strike: selectedSpread.shortLeg.strike, type: 'Put', side: 'short' as const, expiration: selectedSpread.shortLeg.expiration },
        { strike: selectedSpread.longLeg.strike, type: 'Put', side: 'long' as const, expiration: selectedSpread.longLeg.expiration },
      ],
    });
    setShowConfirm(false);
    setSelectedSpread(null);
  }, [selectedSpread, computeSize, addDirect]);

  const handleAction = useCallback(
    async (id: string, action: PositionActionType, exitType?: Position['exit_type']) => {
      await positionAction.mutateAsync({ id, action, exitType });
    }, [positionAction]
  );

  const handleUpdatePrice = useCallback(
    async (id: string, price: number) => { await updatePrice.mutateAsync({ id, price }); },
    [updatePrice]
  );

  // Expiry countdown for active DTE5
  const expiryInfo = useMemo(() => {
    if (!activeDte5?.expiration) return null;
    const [y, m, d] = activeDte5.expiration.split('-').map(Number);
    const expiryMs = new Date(Date.UTC(y, m - 1, d, 21, 0, 0)).getTime();
    const msLeft = Math.max(0, expiryMs - Date.now());
    const daysLeft = Math.floor(msLeft / 86400000);
    const hoursLeft = Math.floor((msLeft % 86400000) / 3600000);
    const progress = Math.min(100, Math.max(0, ((5 * 86400000 - msLeft) / (5 * 86400000)) * 100));
    return { daysLeft, hoursLeft, progress, expiration: activeDte5.expiration };
  }, [activeDte5]);

  // As-of date (from first signal that has data)
  const asOfDate = allSignals.find(s => s.asOfDate)?.asOfDate ?? null;

  return (
    <div className="fade-in max-w-2xl mx-auto space-y-4">
      {/* ── Header Strip ── */}
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="page-header">Mission Control</h1>
          <p className="page-subtitle">DTE5 Bull Put · Paper Trading</p>
        </div>
        <div className="text-right">
          <div className={`text-lg font-bold font-mono ${perfStats.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
            ${perfStats.pnl >= 0 ? '+' : ''}{perfStats.pnl.toFixed(0)}
          </div>
          <div className="text-text-tertiary text-[10px]">{perfStats.trades} trades · {perfStats.winRate}% WR</div>
        </div>
      </div>

      {/* ── Signals Table ── */}
      <div className="card">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border-default">
          <span className="text-text-secondary text-xs font-semibold">Signals</span>
          {asOfDate && <span className="text-text-tertiary text-[10px]">as of {asOfDate}</span>}
        </div>
        <div className="divide-y divide-border-default">
          {allSignals.map(sig => (
            <div key={sig.ticker} className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2">
                <div className={`w-1.5 h-1.5 rounded-full ${sig.isActive ? 'bg-accent-green pulse' : 'bg-text-tertiary'}`} />
                <span className="text-text-primary text-sm font-semibold w-10">{sig.ticker}</span>
                <span className={`text-xs ${sig.isActive ? 'text-accent-green' : 'text-text-tertiary'}`}>
                  {sig.isActive ? 'Bull' : sig.direction === 'PUT' ? 'Bear' : 'Off'}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {sig.streak > 0 && (
                  <span className="text-text-tertiary text-[10px] font-mono">
                    {sig.streak}d streak
                  </span>
                )}
                {sig.score != null && (
                  <span className="text-text-tertiary text-[10px] font-mono w-8 text-right">
                    {sig.score}
                  </span>
                )}
                {sig.isActive && sig.ticker === 'QQQ' && !activeDte5 && (
                  <span className="badge badge-green text-[9px] py-0.5 px-1.5">ENTRY</span>
                )}
              </div>
            </div>
          ))}
          {allSignals.length === 0 && (
            <div className="px-3 py-3 text-text-tertiary text-xs">No signal data available</div>
          )}
        </div>
      </div>

      {/* ── Active Positions ── */}
      {activePositions.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-text-secondary text-xs font-semibold">Active Positions ({activePositions.length})</span>
            {expiryInfo && (
              <span className="text-text-tertiary text-[10px] font-mono">
                {expiryInfo.daysLeft}d {expiryInfo.hoursLeft}h to expiry
              </span>
            )}
          </div>
          {/* Expiry progress bar (if DTE5 position) */}
          {expiryInfo && (
            <div className="w-full bg-bg-tertiary rounded-full h-1.5 mb-3">
              <div
                className="h-1.5 rounded-full bg-accent-blue transition-all"
                style={{ width: `${expiryInfo.progress}%` }}
              />
            </div>
          )}
          <div className="space-y-3">
            {activePositions.map(pos => (
              <PositionCard
                key={pos.id}
                position={pos}
                transactions={transactions.filter(t => t.position_id === pos.id)}
                onAction={handleAction}
                onUpdatePrice={handleUpdatePrice}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Recommended Spreads (when signal active + no position) ── */}
      {canEnter && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-text-secondary text-xs font-semibold">Recommended Spreads</span>
            <span className="text-text-tertiary text-[10px]">
              ${maxRiskDollars.toFixed(0)} risk budget ({riskPctPerTrade}%)
            </span>
          </div>
          {spreadsQuery.isLoading && (
            <div className="card p-4 text-center">
              <div className="spinner mx-auto mb-1" />
              <p className="text-text-tertiary text-[10px]">Scanning...</p>
            </div>
          )}
          {spreadsQuery.data && spreadsQuery.data.length === 0 && (
            <div className="card px-3 py-2">
              <p className="text-text-tertiary text-xs">No qualifying spreads in DTE 2-7 window.</p>
            </div>
          )}
          {spreadsQuery.data?.map((spread, i) => {
            const { contracts, maxProfit, maxLoss, riskPct } = computeSize(spread);
            const credit = spread.netCredit ?? 0;
            return (
              <div
                key={`${spread.shortLeg.strike}-${spread.longLeg.strike}-${i}`}
                className="card px-3 py-2.5 cursor-pointer hover:border-accent-blue/50 transition-colors mb-2"
                onClick={() => { setSelectedSpread(spread); setShowConfirm(true); }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-text-primary font-semibold text-sm">
                      {spread.shortLeg.strike}/{spread.longLeg.strike}
                    </span>
                    <span className="text-text-tertiary text-[10px]">{spread.shortLeg.dte}d</span>
                  </div>
                  <span className="text-accent-green font-mono text-sm">${credit.toFixed(2)}</span>
                </div>
                <div className="flex gap-4 mt-1 text-[10px] text-text-tertiary font-mono">
                  <span>{contracts} ct</span>
                  <span className="text-accent-green">+${maxProfit.toFixed(0)}</span>
                  <span>-${maxLoss.toFixed(0)} ({riskPct}%)</span>
                </div>
              </div>
            );
          })}
          <p className="text-text-tertiary text-[10px] mt-1">Best entry: 10:00–10:30 AM</p>
        </div>
      )}

      {/* ── Quick Stats (when no positions) ── */}
      {activePositions.length === 0 && !canEnter && perfStats.trades > 0 && (
        <div className="card px-3 py-3">
          <div className="grid grid-cols-4 gap-2 text-center">
            <div>
              <div className="text-text-tertiary text-[9px] uppercase tracking-wider">P&L</div>
              <div className={`font-mono text-sm font-semibold ${perfStats.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                ${perfStats.pnl.toFixed(0)}
              </div>
            </div>
            <div>
              <div className="text-text-tertiary text-[9px] uppercase tracking-wider">WR</div>
              <div className="font-mono text-sm font-semibold text-text-primary">{perfStats.winRate}%</div>
            </div>
            <div>
              <div className="text-text-tertiary text-[9px] uppercase tracking-wider">Trades</div>
              <div className="font-mono text-sm font-semibold text-text-primary">{perfStats.trades}</div>
            </div>
            <div>
              <div className="text-text-tertiary text-[9px] uppercase tracking-wider">Avg Cr</div>
              <div className="font-mono text-sm font-semibold text-text-primary">${perfStats.avgCredit.toFixed(2)}</div>
            </div>
          </div>
          <div className="flex justify-center gap-3 mt-2 text-[10px] text-text-tertiary border-t border-border-default pt-2">
            <span>Backtest: WR 80%</span>
            <span>Sharpe 1.18</span>
            <span>CAGR 38.8%</span>
          </div>
        </div>
      )}

      {/* ── Waiting state ── */}
      {activePositions.length === 0 && !canEnter && perfStats.trades === 0 && (
        <div className="card px-3 py-3 text-center">
          <p className="text-text-tertiary text-xs">No positions or signals yet. Check back after market close.</p>
        </div>
      )}

      {/* ── Confirm Modal ── */}
      {showConfirm && selectedSpread && (() => {
        const { contracts, maxLoss, maxProfit } = computeSize(selectedSpread);
        const credit = selectedSpread.netCredit ?? 0;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center modal-overlay" onClick={() => setShowConfirm(false)}>
            <div className="card p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
              <h3 className="text-text-primary font-semibold text-sm mb-3">Confirm DTE5 Bull Put</h3>
              <div className="space-y-1.5 text-sm mb-4">
                {[
                  ['Spread', `${selectedSpread.shortLeg.strike}/${selectedSpread.longLeg.strike} put`],
                  ['Expiry', selectedSpread.shortLeg.expiration],
                  ['Contracts', String(contracts)],
                  ['Credit', `$${credit.toFixed(2)}`],
                  ['Max Profit', `$${maxProfit.toFixed(0)}`],
                  ['Max Risk', `$${maxLoss.toFixed(0)}`],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between">
                    <span className="text-text-tertiary">{label}</span>
                    <span className={`font-mono ${label === 'Max Risk' ? 'text-accent-red' : label === 'Credit' || label === 'Max Profit' ? 'text-accent-green' : 'text-text-primary'}`}>{value}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button className="action-btn btn-secondary" onClick={() => setShowConfirm(false)} disabled={addDirect.isPending}>Cancel</button>
                <button className="action-btn btn-primary" onClick={handleConfirm} disabled={addDirect.isPending}>
                  {addDirect.isPending ? 'Logging...' : 'Log Position'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
