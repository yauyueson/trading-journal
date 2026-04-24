import { useMemo, useCallback } from 'react';
import { TrendingUp, TrendingDown, Zap } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { PageTransition, StaggerItem, SlideRight, motion } from '../components/Motion';
import { useAppSettings } from '../context/AppSettingsContext';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';
import { usePositionAction, useUpdatePrice } from '../hooks/usePositionMutations';
import { useAutoCloseStuckPositions } from '../hooks/useAutoCloseStuckPositions';
import { PositionCard } from '../components/PositionCard';
import type { Position, PositionAction as PositionActionType } from '../lib/types';
import { computePositionPnL, getStrategyKind, groupTransactionsByPositionId } from '../lib/utils';
import { ACTIVE_STRATEGIES, STRATEGY_PROFILES, type StrategyType } from '../lib/strategyProfiles';

export function DashboardPage() {
  const { settings } = useAppSettings();
  const { data: positions = [] } = usePositions();
  const { data: transactions = [] } = useTransactions();
  const positionAction = usePositionAction();
  const updatePrice = useUpdatePrice();
  const transactionsByPosition = useMemo(
    () => groupTransactionsByPositionId(transactions),
    [transactions],
  );

  useAutoCloseStuckPositions(positions, transactions);

  const activePositions = useMemo(
    () => positions
      .filter(p => p.status === 'active')
      .sort((a, b) => (a.expiration ?? '').localeCompare(b.expiration ?? '')),
    [positions]
  );

  // Per-strategy board data: capital, open position, cumulative P&L.
  const boards = useMemo(() => ACTIVE_STRATEGIES.map(strategy => {
    const profile = STRATEGY_PROFILES[strategy];
    const capKey = strategy === 'bcd' ? 'bcdCapital' : strategy === 'pmcc' ? 'pmccCapital' : 'dte5Capital';
    const capital = settings[capKey]?.startingCapital ?? 0;
    const riskPctPerTrade = settings[capKey]?.riskPctPerTrade ?? 0;
    const open = positions.find(p => p.strategy_type === strategy && p.status === 'active') ?? null;
    const closed = positions.filter(p => p.strategy_type === strategy && p.status === 'closed');
    let pnl = 0;
    let wins = 0;
    for (const pos of closed) {
      const txns = transactionsByPosition[pos.id] ?? [];
      const p = computePositionPnL(txns, getStrategyKind(pos));
      pnl += p;
      if (p > 0) wins++;
    }
    return {
      strategy,
      profile,
      capital,
      riskPctPerTrade,
      open,
      closedCount: closed.length,
      winRate: closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0,
      pnl,
      returnPct: capital > 0 ? (pnl / capital) * 100 : 0,
    };
  }), [positions, transactionsByPosition, settings]);

  // Combined performance across all active strategies — for the hero P&L + chart.
  const { perfStats, chartData } = useMemo(() => {
    const closedAll = positions
      .filter(p => p.strategy_type && ACTIVE_STRATEGIES.includes(p.strategy_type as StrategyType) && p.status === 'closed')
      .sort((a, b) => (a.closed_at ?? '').localeCompare(b.closed_at ?? ''));
    if (closedAll.length === 0) {
      return { perfStats: { pnl: 0, winRate: 0, trades: 0 }, chartData: [] as { trade: string; pnl: number }[] };
    }
    let wins = 0;
    let totalPnl = 0;
    const data: { trade: string; pnl: number }[] = [{ trade: '0', pnl: 0 }];
    for (let i = 0; i < closedAll.length; i++) {
      const pos = closedAll[i];
      const txns = transactionsByPosition[pos.id] ?? [];
      const pnl = computePositionPnL(txns, getStrategyKind(pos));
      totalPnl += pnl;
      if (pnl > 0) wins++;
      data.push({ trade: String(i + 1), pnl: totalPnl });
    }
    return {
      perfStats: {
        pnl: totalPnl,
        winRate: Math.round((wins / closedAll.length) * 100),
        trades: closedAll.length,
      },
      chartData: data,
    };
  }, [positions, transactionsByPosition]);

  const totalCapital = boards.reduce((sum, b) => sum + b.capital, 0);
  const returnPct = totalCapital > 0 ? (perfStats.pnl / totalCapital) * 100 : 0;

  const handleAction = useCallback(
    async (id: string, action: PositionActionType, exitType?: Position['exit_type']) => {
      await positionAction.mutateAsync({ id, action, exitType });
    }, [positionAction]
  );

  const handleUpdatePrice = useCallback(
    async (id: string, price: number) => { await updatePrice.mutateAsync({ id, price }); },
    [updatePrice]
  );

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
              Net P&L · BCD + PMCC
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
              {perfStats.trades} trades · {perfStats.winRate}% WR · {ACTIVE_STRATEGIES.length} active strategies
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
                  <p className="text-text-tertiary text-xs mt-1">Chart appears after your first closed BCD or PMCC trade.</p>
                </motion.div>
              </div>
            )}
          </motion.div>

          {/* Per-strategy status chips */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.5 }}
            className="flex items-center gap-4 mt-3 text-text-tertiary text-xs flex-wrap"
          >
            {boards.map(b => (
              <span key={b.strategy} className="flex items-center gap-1.5">
                <span className={`w-1 h-3 rounded-full ${b.open ? 'bg-accent-green' : 'bg-text-tertiary/30'}`} />
                {b.profile.shortLabel}
                {b.open ? ' · live' : ' · flat'}
              </span>
            ))}
          </motion.div>
        </StaggerItem>

        {/* ── RIGHT — Strategy Boards + Capital ── */}
        <SlideRight className="lg:w-5/12 xl:w-1/3" delay={0.2}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-text-primary text-sm font-semibold">Strategies</h2>
            <span className="text-text-tertiary text-[10px] font-mono">F1 adopted</span>
          </div>
          <div className="space-y-3">
            {boards.map((b, i) => (
              <motion.div
                key={b.strategy}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: 0.3 + i * 0.08 }}
                className="card-glass px-4 py-3"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-text-primary text-sm font-semibold">{b.profile.shortLabel}</span>
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wide uppercase ${
                      b.open ? 'bg-accent-green/15 text-accent-green ring-1 ring-accent-green/20'
                        : 'bg-white/[0.04] text-text-tertiary ring-1 ring-white/[0.06]'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${b.open ? 'bg-accent-green pulse-glow' : 'bg-text-tertiary/30'}`} />
                      {b.open ? 'Open' : 'Flat'}
                    </span>
                  </div>
                  <span className="text-text-tertiary text-[10px] font-mono">${b.capital.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-tertiary">{b.closedCount} trades · {b.winRate}% WR</span>
                  <span className={`font-mono font-semibold ${b.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {b.pnl >= 0 ? '+' : ''}${Math.abs(b.pnl).toFixed(0)}
                  </span>
                </div>
                <p className="text-text-tertiary text-[10px] mt-1 truncate">{b.profile.subtitle}</p>
              </motion.div>
            ))}
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
                <span className="text-text-tertiary text-xs">Total allocated</span>
                <span className="text-text-primary text-sm font-mono font-semibold">${totalCapital.toLocaleString()}</span>
              </div>
              {boards.map(b => {
                const riskDollars = b.capital * (b.riskPctPerTrade / 100);
                return (
                  <div key={b.strategy} className="flex items-center justify-between">
                    <span className="text-text-tertiary text-xs">{b.profile.shortLabel} risk / trade</span>
                    <span className="text-accent-coral text-sm font-mono font-semibold">
                      ${riskDollars.toFixed(0)} ({b.riskPctPerTrade}%)
                    </span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        </SlideRight>
      </div>

      {/* ── BOTTOM: Active positions ── */}
      {activePositions.length > 0 && (
        <StaggerItem className="mt-8 pt-6 border-t border-white/[0.06]">
          <h2 className="text-text-primary text-sm font-semibold mb-4">
            Active Positions <span className="text-text-tertiary font-normal ml-2">{activePositions.length}</span>
          </h2>
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
                  transactions={transactionsByPosition[pos.id] ?? []}
                  onAction={handleAction}
                  onUpdatePrice={handleUpdatePrice}
                />
              </motion.div>
            ))}
          </div>
        </StaggerItem>
      )}

      {/* Empty state */}
      {activePositions.length === 0 && perfStats.trades === 0 && (
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
            <p className="text-text-secondary text-sm font-medium">No positions yet</p>
            <p className="text-text-tertiary text-xs mt-1">BCD and PMCC entries will appear on the Signals page once live trading begins.</p>
          </motion.div>
        </StaggerItem>
      )}
    </PageTransition>
  );
}
