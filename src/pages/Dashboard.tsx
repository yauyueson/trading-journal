import { useMemo, useCallback, useState } from 'react';
import { TrendingUp, TrendingDown, Zap } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { PageTransition, StaggerItem, SlideRight, motion } from '../components/Motion';
import { useAppSettings } from '../context/AppSettingsContext';
import { usePositions } from '../hooks/usePositions';
import { useTransactions } from '../hooks/useTransactions';
import { usePositionAction, useUpdatePrice } from '../hooks/usePositionMutations';
import { useAutoCloseStuckPositions } from '../hooks/useAutoCloseStuckPositions';
import { useStrategyStatus } from '../hooks/useStrategyStatus';
import { PositionCard } from '../components/PositionCard';
import { StrategyActionCard } from '../components/StrategyActionCard';
import { BCDEntryModal } from '../components/BCDEntryModal';
import { PMCCEntryModal } from '../components/PMCCEntryModal';
import type { Position, PositionAction as PositionActionType } from '../lib/types';
import { computePositionPnL, getStrategyKind, groupTransactionsByPositionId } from '../lib/utils';
import { ACTIVE_STRATEGIES, STRATEGY_PROFILES, type StrategyType } from '../lib/strategyProfiles';
import { CHART_COLORS, CHART_FONT_MONO, axisProps } from '../lib/chartTheme';

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
  const strategyStatuses = useStrategyStatus();
  const [entryModal, setEntryModal] = useState<StrategyType | null>(null);

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

  const chartColor = perfStats.pnl >= 0 ? CHART_COLORS.positive : CHART_COLORS.negative;

  return (
    <PageTransition>
      {/* ── TIER 1 — TODAY / ACTION strip: per-strategy status + entry CTA ── */}
      <StaggerItem className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-phosphor-green text-glow-green text-xs font-mono font-bold uppercase tracking-widest">
            ▌ TODAY <span className="text-phosphor-dim/70 font-normal ml-2">// SIGNAL_QUEUE</span>
          </h2>
          <span className="text-phosphor-dim/70 text-[10px] font-mono uppercase tracking-wider">
            {strategyStatuses.filter(s => s.state === 'ready').length} READY · {strategyStatuses.filter(s => s.state === 'open').length} OPEN
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          {strategyStatuses.map((status, i) => (
            <motion.div
              key={status.strategy}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.06 }}
            >
              <StrategyActionCard
                status={status}
                positionTransactions={
                  status.openPosition ? transactionsByPosition[status.openPosition.id] ?? [] : []
                }
                onEnter={() => setEntryModal(status.strategy)}
              />
            </motion.div>
          ))}
        </div>
      </StaggerItem>

      {/* ── HERO STRIP — terminal headline + 3 KPI tiles with scanlines ── */}
      <StaggerItem className="mb-6">
        <div className="terminal-panel scanlines px-4 sm:px-5 py-4 sm:py-5">
          <motion.h1
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            className="text-[11px] sm:text-xs font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green mb-4"
          >
            ▌ STRATEGY_OPS // <span className="text-phosphor-amber text-glow-amber">[LIVE]</span><span className="cursor-blink" aria-hidden="true"></span>
          </motion.h1>
          <div className="grid grid-cols-3 gap-3 sm:gap-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1], delay: 0.1 }}
            >
              <span className="label-mono">NET P&L</span>
              <p className={`font-mono font-bold tabular-nums leading-none mt-1 ${perfStats.pnl >= 0 ? 'metric-glow-pos' : 'metric-glow-neg'}`}
                 style={{ fontSize: 'clamp(1.5rem, 5.5vw, 2.75rem)' }}>
                {perfStats.pnl >= 0 ? '+' : ''}${Math.abs(perfStats.pnl).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </p>
              <span className={`inline-flex items-center gap-1 mt-2 text-[10px] sm:text-xs font-mono font-semibold ${
                returnPct >= 0 ? 'text-phosphor-green' : 'text-phosphor-red'
              }`}>
                {returnPct >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {returnPct >= 0 ? '+' : ''}{returnPct.toFixed(2)}%
              </span>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1], delay: 0.15 }}
            >
              <span className="label-mono">WIN RATE</span>
              <p className="font-mono font-bold tabular-nums leading-none mt-1 text-text-primary"
                 style={{ fontSize: 'clamp(1.5rem, 5.5vw, 2.75rem)' }}>
                {perfStats.winRate}<span className="text-text-tertiary text-base">%</span>
              </p>
              <span className="inline-block mt-2 text-[10px] sm:text-xs font-mono text-text-tertiary">
                CLOSED_TRADES_BASIS
              </span>
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1], delay: 0.2 }}
            >
              <span className="label-mono">TRADES</span>
              <p className="font-mono font-bold tabular-nums leading-none mt-1 text-text-primary"
                 style={{ fontSize: 'clamp(1.5rem, 5.5vw, 2.75rem)' }}>
                {perfStats.trades}
              </p>
              <span className="inline-block mt-2 text-[10px] sm:text-xs font-mono text-text-tertiary">
                {ACTIVE_STRATEGIES.length} ACTIVE_STRATS
              </span>
            </motion.div>
          </div>
        </div>
      </StaggerItem>

      {/* ── TOP: Two-column ── */}
      <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">

        {/* ── LEFT — Chart ── */}
        <StaggerItem className="lg:w-7/12 xl:w-2/3">
          <div className="mb-1">
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.4 }}
              className="text-phosphor-dim/70 text-[10px] uppercase tracking-widest font-mono font-semibold mb-2"
            >
              ▌ EQUITY_CURVE // CUMULATIVE_P&L
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
                      <stop offset="5%" stopColor={chartColor} stopOpacity={0.28} />
                      <stop offset="95%" stopColor={chartColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="3 3" />
                  <XAxis dataKey="trade" {...axisProps} axisLine={{ stroke: CHART_COLORS.axisLine }} />
                  <YAxis {...axisProps} axisLine={false}
                    tickFormatter={(v: number) => `$${v >= 0 ? '' : '-'}${Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + 'K' : Math.abs(v).toFixed(0)}`}
                  />
                  <Tooltip
                    contentStyle={{ background: CHART_COLORS.tooltipBg, border: `1px solid ${CHART_COLORS.tooltipBorder}`, borderRadius: 6, fontSize: 12, fontFamily: CHART_FONT_MONO, boxShadow: CHART_COLORS.tooltipShadow }}
                    formatter={(value: number | undefined) => [`$${(value ?? 0) >= 0 ? '+' : ''}${(value ?? 0).toFixed(0)}`, 'P&L']}
                    labelFormatter={(label) => `TRADE #${label}`}
                  />
                  <Area type="monotone" dataKey="pnl" stroke={chartColor} strokeWidth={2} fill="url(#pnlGrad)" dot={false}
                    activeDot={{ r: 4, fill: chartColor, stroke: CHART_COLORS.tooltipBg, strokeWidth: 2 }}
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

        </StaggerItem>

        {/* ── RIGHT — Strategy Boards + Capital ── */}
        <SlideRight className="lg:w-5/12 xl:w-1/3" delay={0.2}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-phosphor-green text-glow-green text-xs font-mono font-bold uppercase tracking-widest">▌ STRATEGIES</h2>
            <span className="text-phosphor-dim/70 text-[10px] font-mono uppercase tracking-wider">F1_ADOPTED</span>
          </div>
          <div className="space-y-3">
            {boards.map((b, i) => (
              <motion.div
                key={b.strategy}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: 0.3 + i * 0.08 }}
                className={`terminal-panel px-4 py-3 ${b.open ? '' : ''}`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-text-primary font-mono text-sm font-bold uppercase tracking-wider">{b.profile.shortLabel}</span>
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase ${
                      b.open
                        ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green ring-1 ring-phosphor-green/30'
                        : 'bg-white/[0.04] text-text-tertiary ring-1 ring-white/[0.06]'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${b.open ? 'bg-phosphor-green pulse-glow' : 'bg-text-tertiary/30'}`} />
                      {b.open ? 'OPEN' : 'FLAT'}
                    </span>
                  </div>
                  <span className="text-phosphor-dim/70 text-[10px] font-mono tabular-nums">${b.capital.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-tertiary font-mono">{b.closedCount} TRADES · {b.winRate}% WR</span>
                  <span className={`font-mono font-bold tabular-nums ${b.pnl >= 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'}`}>
                    {b.pnl >= 0 ? '+' : ''}${Math.abs(b.pnl).toFixed(0)}
                  </span>
                </div>
                <p className="text-text-tertiary text-[10px] font-mono mt-1 truncate">{b.profile.subtitle}</p>
              </motion.div>
            ))}
          </div>

          {/* Capital summary */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.5 }}
            className="mt-6 pt-4 border-t border-phosphor-green/15"
          >
            <h2 className="text-phosphor-green text-glow-green text-xs font-mono font-bold uppercase tracking-widest mb-3">▌ CAPITAL</h2>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-text-tertiary text-[11px] font-mono uppercase tracking-wider">Total allocated</span>
                <span className="text-text-primary text-sm font-mono font-bold tabular-nums">${totalCapital.toLocaleString()}</span>
              </div>
              {boards.map(b => {
                const riskDollars = b.capital * (b.riskPctPerTrade / 100);
                return (
                  <div key={b.strategy} className="flex items-center justify-between">
                    <span className="text-text-tertiary text-[11px] font-mono uppercase tracking-wider">{b.profile.shortLabel} risk / trade</span>
                    <span className="text-phosphor-amber text-glow-amber text-sm font-mono font-bold tabular-nums">
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
        <StaggerItem className="mt-8 pt-6 border-t border-phosphor-green/15">
          <h2 className="text-phosphor-green text-glow-green text-xs font-mono font-bold uppercase tracking-widest mb-4">
            ▌ ACTIVE_POSITIONS <span className="text-phosphor-dim/70 font-normal ml-2">[{activePositions.length}]</span>
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

      <BCDEntryModal
        isOpen={entryModal === 'bcd'}
        onClose={() => setEntryModal(null)}
      />
      <PMCCEntryModal
        isOpen={entryModal === 'pmcc'}
        onClose={() => setEntryModal(null)}
      />
    </PageTransition>
  );
}
