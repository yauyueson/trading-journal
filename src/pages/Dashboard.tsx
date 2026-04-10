import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, Zap } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { PageTransition, StaggerItem, SlideRight, motion } from '../components/Motion';
import { useAppSettings } from '../context/AppSettingsContext';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';
import { useAddDirect, usePositionAction, useUpdatePrice } from '../hooks/usePositionMutations';
import { useAutoCloseStuckPositions } from '../hooks/useAutoCloseStuckPositions';
import { PositionCard } from '../components/PositionCard';
import { SpreadPickerModal } from '../components/SpreadPickerModal';
import { useAllSignals } from '../hooks/useSignalStatus';
import type { Position, PositionAction as PositionActionType, SpreadRecommendation } from '../lib/types';
import { CONTRACT_MULTIPLIER, computePositionPnL, isCreditStrategy } from '../lib/utils';

const DTE5_TICKERS = ['QQQ'];

export function DashboardPage() {
  const { settings } = useAppSettings();
  const { data: positions = [] } = usePositions();
  const { data: transactions = [] } = useTransactions();
  const { data: allSignals = [] } = useAllSignals(DTE5_TICKERS);
  const addDirect = useAddDirect();
  const positionAction = usePositionAction();
  const updatePrice = useUpdatePrice();

  useAutoCloseStuckPositions(positions, transactions);

  const [selectedSpread, setSelectedSpread] = useState<SpreadRecommendation | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pickerSignal, setPickerSignal] = useState<{ ticker: string; side: 'bull' | 'bear'; spread: string } | null>(null);

  const capital = settings.dte5Capital?.startingCapital ?? 10000;
  const riskPctPerTrade = settings.dte5Capital?.riskPctPerTrade ?? 10;
  const maxRiskDollars = capital * (riskPctPerTrade / 100);

  const activePositions = useMemo(
    () => positions.filter(p => p.status === 'active').sort((a, b) => (a.expiration ?? '').localeCompare(b.expiration ?? '')),
    [positions]
  );

  const activeDte5 = useMemo(
    () => positions.find(p => p.strategy_type === 'dte5' && p.status === 'active') ?? null,
    [positions]
  );

  const qqSignal = allSignals.find(s => s.ticker === 'QQQ');
  const signalActive = qqSignal?.isActive ?? false;
  const canEnter = signalActive && !activeDte5;

  const { perfStats, chartData } = useMemo(() => {
    const closed = positions
      .filter(p => p.strategy_type === 'dte5' && p.status === 'closed')
      .sort((a, b) => (a.closed_at ?? '').localeCompare(b.closed_at ?? ''));
    if (closed.length === 0) return { perfStats: { pnl: 0, winRate: 0, trades: 0, avgCredit: 0 }, chartData: [] };
    let wins = 0, totalPnl = 0, totalCredit = 0;
    const data: { trade: string; pnl: number }[] = [{ trade: '0', pnl: 0 }];
    for (let i = 0; i < closed.length; i++) {
      const pos = closed[i];
      const txns = transactions.filter(t => t.position_id === pos.id);
      const opens = txns.filter(t => t.type === 'Open');
      const pnl = computePositionPnL(txns, isCreditStrategy(pos.type));
      totalPnl += pnl;
      if (pnl > 0) wins++;
      if (opens.length > 0) totalCredit += opens[0].price;
      data.push({ trade: String(i + 1), pnl: totalPnl });
    }
    return {
      perfStats: { pnl: totalPnl, winRate: Math.round((wins / closed.length) * 100), trades: closed.length, avgCredit: closed.length > 0 ? totalCredit / closed.length : 0 },
      chartData: data,
    };
  }, [positions, transactions]);

  const returnPct = capital > 0 ? ((perfStats.pnl / capital) * 100) : 0;

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
    const contracts = riskPerContract > 0 ? Math.floor(maxRiskDollars / riskPerContract) : 0;
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

  const asOfDate = allSignals.find(s => s.asOfDate)?.asOfDate ?? null;
  const chartColor = perfStats.pnl >= 0 ? '#4EBE96' : '#FF6B6B';

  return (
    <PageTransition>

      {/* ── TOP: Two-column ── */}
      <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">

        {/* ── LEFT — P&L + Chart ── */}
        <StaggerItem className="lg:w-7/12 xl:w-2/3">
          <div className="mb-1">
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
              className="text-text-tertiary text-xs uppercase tracking-[0.15em] font-semibold mb-2"
            >
              Net P&L
            </motion.p>
            <div className="flex items-baseline gap-3 flex-wrap">
              <motion.span
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1], delay: 0.1 }}
                className={`hero-number ${perfStats.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}
              >
                {perfStats.pnl >= 0 ? '+' : ''}${Math.abs(perfStats.pnl).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </motion.span>
              <motion.span
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4, delay: 0.3 }}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold ${
                  returnPct >= 0 ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'
                }`}
              >
                {returnPct >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {returnPct >= 0 ? '+' : ''}{returnPct.toFixed(2)}%
              </motion.span>
            </div>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.2 }}
              className="text-text-tertiary text-xs mt-1.5 font-mono"
            >
              {perfStats.trades} trades · {perfStats.winRate}% WR · Avg ${perfStats.avgCredit.toFixed(2)} credit
            </motion.p>
          </div>

          {/* Chart */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
            className="h-[180px] sm:h-[280px] mt-4"
          >
            {chartData.length >= 2 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 5, right: 5, left: -15, bottom: 5 }}>
                  <defs>
                    <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={chartColor} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.04)" strokeDasharray="3 3" />
                  <XAxis dataKey="trade" tick={{ fill: '#666', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'rgba(255,255,255,0.06)' }} />
                  <YAxis tick={{ fill: '#666', fontSize: 11 }} tickLine={false} axisLine={false}
                    tickFormatter={(v: number) => `$${v >= 0 ? '' : '-'}${Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + 'K' : Math.abs(v).toFixed(0)}`}
                  />
                  <Tooltip
                    contentStyle={{ background: '#1A1A1A', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, fontSize: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
                    formatter={(value: number | undefined) => [`$${(value ?? 0) >= 0 ? '+' : ''}${(value ?? 0).toFixed(0)}`, 'P&L']}
                    labelFormatter={(label) => `Trade #${label}`}
                  />
                  <Area type="monotone" dataKey="pnl" stroke={chartColor} strokeWidth={2} fill="url(#pnlGrad)" dot={false}
                    activeDot={{ r: 4, fill: chartColor, stroke: '#000', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center">
                <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5, delay: 0.2 }} className="text-center">
                  <div className="w-12 h-12 rounded-full bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                    <Zap size={20} className="text-text-tertiary" />
                  </div>
                  <p className="text-text-secondary text-sm">No trade history yet</p>
                  <p className="text-text-tertiary text-xs mt-1">Chart appears after your first closed trade.</p>
                </motion.div>
              </div>
            )}
          </motion.div>

          {/* Strategy bar */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.5 }}
            className="flex items-center gap-4 mt-3 text-text-tertiary text-xs"
          >
            <span className="flex items-center gap-1.5">
              <span className="w-1 h-3 rounded-full bg-accent-green" />
              DTE5 Bull Put
            </span>
            <span>Live $1K</span>
            {expiryInfo && <span>{expiryInfo.daysLeft}d {expiryInfo.hoursLeft}h to expiry</span>}
          </motion.div>
        </StaggerItem>

        {/* ── RIGHT — Signals ── */}
        <SlideRight className="lg:w-5/12 xl:w-1/3" delay={0.2}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-text-primary text-sm font-semibold">Signals</h2>
            {asOfDate && <span className="text-text-tertiary text-[10px] font-mono">{asOfDate}</span>}
          </div>
          <div className="border-t border-white/[0.06]">
            {allSignals.map((sig, i) => {
              const isBull = sig.isActive;
              const isBear = sig.direction === 'PUT';
              const hasSignal = isBull || isBear;
              const spreadMap: Record<string, string> = { QQQ: 'sp30/20' };
              return (
                <motion.div
                  key={sig.ticker}
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: 0.3 + i * 0.08 }}
                  className={`flex items-center justify-between py-3.5 border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors px-1 ${hasSignal ? 'cursor-pointer' : ''}`}
                  onClick={hasSignal ? () => setPickerSignal({
                    ticker: sig.ticker,
                    side: isBull ? 'bull' : 'bear',
                    spread: spreadMap[sig.ticker] ?? 'sp30/20',
                  }) : undefined}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-text-primary text-sm font-semibold">{sig.ticker}</span>
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide uppercase ${
                      isBull ? 'bg-accent-green/15 text-accent-green ring-1 ring-accent-green/20'
                        : isBear ? 'bg-accent-red/15 text-accent-red ring-1 ring-accent-red/20'
                        : 'bg-white/[0.04] text-text-tertiary ring-1 ring-white/[0.06]'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${isBull ? 'bg-accent-green pulse-glow' : isBear ? 'bg-accent-red' : 'bg-text-tertiary/30'}`} />
                      {isBull ? 'Bull' : isBear ? 'Bear' : 'Off'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {sig.streak > 0 && <span className="text-text-tertiary text-[10px] font-mono">{sig.streak}d</span>}
                    {hasSignal ? (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold ${
                        isBull ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'
                      }`}>
                        Open →
                      </span>
                    ) : null}
                  </div>
                </motion.div>
              );
            })}
            {allSignals.length === 0 && (
              <div className="py-6 text-text-tertiary text-xs text-center">No signal data available</div>
            )}
          </div>

          {/* Capital summary */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.5 }}
            className="mt-6 pt-4 border-t border-white/[0.06]"
          >
            <h2 className="text-text-primary text-sm font-semibold mb-3">Capital</h2>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-text-tertiary text-xs">Account</span>
                <span className="text-text-primary text-sm font-mono font-semibold">${capital.toLocaleString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-tertiary text-xs">Risk / Trade</span>
                <span className="text-accent-coral text-sm font-mono font-semibold">${maxRiskDollars.toFixed(0)} ({riskPctPerTrade}%)</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-tertiary text-xs">Backtest Ref</span>
                <span className="text-text-tertiary text-xs font-mono">SR 1.18 · WR 80% · CAGR 38.8%</span>
              </div>
            </div>
          </motion.div>
        </SlideRight>
      </div>

      {/* ── BOTTOM: Positions & Spreads ── */}
      {(activePositions.length > 0 || canEnter) && (
        <StaggerItem className="mt-8 pt-6 border-t border-white/[0.06]">
          <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
            {activePositions.length > 0 && (
              <div className={canEnter ? 'lg:w-1/2' : 'w-full'}>
                <h2 className="text-text-primary text-sm font-semibold mb-4">
                  Active Positions <span className="text-text-tertiary font-normal ml-2">{activePositions.length}</span>
                </h2>
                {expiryInfo && (
                  <div className="w-full bg-white/[0.03] rounded-full h-1 mb-4 overflow-hidden">
                    <motion.div
                      className="h-1 rounded-full bg-accent-blue"
                      initial={{ width: 0 }}
                      animate={{ width: `${expiryInfo.progress}%` }}
                      transition={{ duration: 1, ease: [0.25, 0.1, 0.25, 1], delay: 0.5 }}
                    />
                  </div>
                )}
                <div className="space-y-3">
                  {activePositions.map((pos, i) => (
                    <motion.div
                      key={pos.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.4, delay: 0.1 + i * 0.08 }}
                    >
                      <PositionCard
                        position={pos}
                        transactions={transactions.filter(t => t.position_id === pos.id)}
                        onAction={handleAction}
                        onUpdatePrice={handleUpdatePrice}
                      />
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {canEnter && (
              <div className={activePositions.length > 0 ? 'lg:w-1/2' : 'w-full'}>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-text-primary text-sm font-semibold">Recommended Spreads</h2>
                  <span className="text-text-tertiary text-xs font-mono">${maxRiskDollars.toFixed(0)} budget</span>
                </div>
                {spreadsQuery.isLoading && (
                  <div className="py-8 text-center"><div className="spinner mx-auto mb-2" /><p className="text-text-tertiary text-xs">Scanning...</p></div>
                )}
                <div className="space-y-2">
                  {spreadsQuery.data?.map((spread, i) => {
                    const { contracts, maxLoss } = computeSize(spread);
                    const credit = spread.netCredit ?? 0;
                    return (
                      <motion.div
                        key={`${spread.shortLeg.strike}-${spread.longLeg.strike}-${i}`}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.3, delay: 0.1 + i * 0.06 }}
                        whileHover={{ scale: 1.01, transition: { duration: 0.15 } }}
                        className="flex items-center justify-between py-3 px-4 rounded-xl border border-white/[0.06] hover:border-accent-blue/30 hover:bg-white/[0.02] cursor-pointer transition-colors"
                        onClick={() => { setSelectedSpread(spread); setShowConfirm(true); }}
                      >
                        <div>
                          <span className="text-text-primary font-semibold text-sm">{spread.shortLeg.strike}/{spread.longLeg.strike}</span>
                          <span className="text-text-tertiary text-xs ml-2">{spread.shortLeg.dte}d · {contracts}ct</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-accent-green font-mono text-sm font-semibold">${credit.toFixed(2)}</span>
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-accent-red/10 text-accent-red">-${maxLoss.toFixed(0)}</span>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </StaggerItem>
      )}

      {/* Empty state */}
      {activePositions.length === 0 && !canEnter && perfStats.trades === 0 && (
        <StaggerItem className="mt-8">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.5, delay: 0.3 }}
            className="card-glass px-6 py-12 text-center"
          >
            <div className="w-12 h-12 rounded-full bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
              <Zap size={20} className="text-text-tertiary" />
            </div>
            <p className="text-text-secondary text-sm font-medium">No positions or signals yet</p>
            <p className="text-text-tertiary text-xs mt-1">Signals update daily after market close.</p>
          </motion.div>
        </StaggerItem>
      )}

      {/* ── Spread Picker (click any signal to open) ── */}
      <SpreadPickerModal signal={pickerSignal} onClose={() => setPickerSignal(null)} />

      {/* ── Confirm Modal (legacy, for recommended spreads section) ── */}
      {showConfirm && selectedSpread && (() => {
        const { contracts, maxLoss, maxProfit } = computeSize(selectedSpread);
        const credit = selectedSpread.netCredit ?? 0;
        return (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center modal-overlay"
            onClick={() => setShowConfirm(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.25, 0.1, 0.25, 1] }}
              className="card-glass-elevated p-6 w-full max-w-sm"
              onClick={e => e.stopPropagation()}
            >
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
            </motion.div>
          </motion.div>
        );
      })()}
    </PageTransition>
  );
}
