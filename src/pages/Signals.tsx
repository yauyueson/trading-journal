import React, { useMemo, useState } from 'react';
import { usePositions } from '../hooks/usePositions';
import { ACTIVE_STRATEGIES, STRATEGY_PROFILES, type StrategyType } from '../lib/strategyProfiles';

// BCD emits a candidate every 10 trading days. Approximate trading-day
// advance with Mon-Fri business-day arithmetic (good enough for display).
function addTradingDays(from: Date, n: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const SignalsPage: React.FC = () => {
  const { data: positions = [] } = usePositions();
  const [activeBoard, setActiveBoard] = useState<StrategyType>(ACTIVE_STRATEGIES[0]);

  const boardContext = useMemo(() => {
    const profile = STRATEGY_PROFILES[activeBoard];
    const openPosition = positions.find(p => p.strategy_type === activeBoard && p.status === 'active') ?? null;
    const lastClosed = positions
      .filter(p => p.strategy_type === activeBoard && p.status === 'closed')
      .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))[0] ?? null;

    if (activeBoard === 'bcd') {
      const ref = lastClosed?.closed_at ?? lastClosed?.created_at ?? null;
      const refDate = ref ? new Date(ref) : new Date();
      const nextEmission = addTradingDays(refDate, 10);
      const today = new Date();
      const tradingDaysSince = ref
        ? Math.max(0, Math.round((today.getTime() - refDate.getTime()) / (86400000 * 1.4)))
        : 10;
      return {
        profile,
        openPosition,
        primaryStatus: openPosition ? 'In trade' : tradingDaysSince >= 10 ? 'Eligible' : 'Waiting',
        statusDetail: openPosition
          ? `Open since ${openPosition.created_at?.slice(0, 10) ?? '?'}`
          : ref
            ? `${tradingDaysSince} trading days since last close. Next emission: ${formatDate(nextEmission)}`
            : `No prior history. Ready to enter on next trading day.`,
      };
    }

    // PMCC — always-in when flat.
    return {
      profile,
      openPosition,
      primaryStatus: openPosition ? 'In trade' : 'Eligible',
      statusDetail: openPosition
        ? `Open since ${openPosition.created_at?.slice(0, 10) ?? '?'}. Roll short leg when underlying within ${(profile.rollTriggerMoneyness ?? 0.02) * 100}% of short strike.`
        : 'Always-in — enter long LEAP + short monthly when portfolio is flat.',
    };
  }, [positions, activeBoard]);

  return (
    <div className="max-w-5xl mx-auto stagger-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Signals</h1>
          <p className="text-xs text-text-tertiary mt-0.5">Active strategies — enter via the Portfolio tab (BCD/PMCC modals ship in Phase C).</p>
        </div>
      </div>

      {/* Strategy tabs */}
      <div className="flex items-center gap-2 mb-6 border-b border-white/[0.06]">
        {ACTIVE_STRATEGIES.map(s => {
          const profile = STRATEGY_PROFILES[s];
          const isActive = activeBoard === s;
          return (
            <button
              key={s}
              onClick={() => setActiveBoard(s)}
              className={`px-4 py-2 text-xs font-semibold border-b-2 transition-colors ${
                isActive
                  ? 'border-accent-green text-text-primary'
                  : 'border-transparent text-text-tertiary hover:text-text-secondary'
              }`}
            >
              {profile.shortLabel}
            </button>
          );
        })}
      </div>

      {/* Board content */}
      <div className="card-glass p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-text-primary text-base font-semibold">{boardContext.profile.label}</h2>
            <p className="text-xs text-text-tertiary mt-1">{boardContext.profile.subtitle}</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-bold tracking-wide uppercase ${
            boardContext.openPosition
              ? 'bg-accent-blue/15 text-accent-blue ring-1 ring-accent-blue/20'
              : boardContext.primaryStatus === 'Eligible'
                ? 'bg-accent-green/15 text-accent-green ring-1 ring-accent-green/20'
                : 'bg-white/[0.04] text-text-tertiary ring-1 ring-white/[0.06]'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              boardContext.openPosition ? 'bg-accent-blue' : boardContext.primaryStatus === 'Eligible' ? 'bg-accent-green pulse-glow' : 'bg-text-tertiary/30'
            }`} />
            {boardContext.primaryStatus}
          </span>
        </div>

        <p className="text-sm text-text-secondary mb-6">{boardContext.statusDetail}</p>

        {/* Strategy params */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs">
          <div>
            <p className="text-text-tertiary mb-1">Universe</p>
            <p className="text-text-primary font-mono">{boardContext.profile.tickers?.join(', ') ?? 'QQQ'}</p>
          </div>
          {boardContext.profile.kind === 'debit_spread' && (
            <>
              <div>
                <p className="text-text-tertiary mb-1">Long δ / Short δ</p>
                <p className="text-text-primary font-mono">
                  {boardContext.profile.defaultDelta.toFixed(2)} / {(0.20).toFixed(2)}
                </p>
              </div>
              <div>
                <p className="text-text-tertiary mb-1">DTE range</p>
                <p className="text-text-primary font-mono">{boardContext.profile.dteMin}-{boardContext.profile.dteMax}d</p>
              </div>
              <div>
                <p className="text-text-tertiary mb-1">Profit target</p>
                <p className="text-text-primary font-mono">+{(boardContext.profile.profitTarget * 100).toFixed(0)}%</p>
              </div>
              <div>
                <p className="text-text-tertiary mb-1">Cadence</p>
                <p className="text-text-primary font-mono">Every 10 trading days</p>
              </div>
              <div>
                <p className="text-text-tertiary mb-1">Signal</p>
                <p className="text-text-primary font-mono">No timing filter</p>
              </div>
            </>
          )}
          {boardContext.profile.kind === 'diagonal' && (
            <>
              <div>
                <p className="text-text-tertiary mb-1">Long δ range</p>
                <p className="text-text-primary font-mono">
                  {boardContext.profile.longDeltaMin?.toFixed(2)}–{boardContext.profile.longDeltaMax?.toFixed(2)}
                </p>
              </div>
              <div>
                <p className="text-text-tertiary mb-1">Long DTE range</p>
                <p className="text-text-primary font-mono">{boardContext.profile.longDteMin}–{boardContext.profile.longDteMax}d</p>
              </div>
              <div>
                <p className="text-text-tertiary mb-1">Short δ range</p>
                <p className="text-text-primary font-mono">
                  {boardContext.profile.shortDeltaMin?.toFixed(2)}–{boardContext.profile.shortDeltaMax?.toFixed(2)}
                </p>
              </div>
              <div>
                <p className="text-text-tertiary mb-1">Short DTE range</p>
                <p className="text-text-primary font-mono">{boardContext.profile.shortDteMin}–{boardContext.profile.shortDteMax}d</p>
              </div>
              <div>
                <p className="text-text-tertiary mb-1">Long PT / SL</p>
                <p className="text-text-primary font-mono">
                  +{((boardContext.profile.longProfitTarget ?? 0) * 100).toFixed(0)}% / −{((boardContext.profile.longStopLoss ?? 0) * 100).toFixed(0)}%
                </p>
              </div>
              <div>
                <p className="text-text-tertiary mb-1">Short PT / roll</p>
                <p className="text-text-primary font-mono">
                  +{((boardContext.profile.shortProfitTarget ?? 0) * 100).toFixed(0)}% / {((boardContext.profile.rollTriggerMoneyness ?? 0.02) * 100).toFixed(0)}% moneyness
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      <p className="text-[10px] text-text-tertiary mt-6">
        Entry flow (BCDEntryModal / PMCCEntryModal) ships in Phase C. Until then, use the Portfolio quick-add form to log a trade manually.
      </p>
    </div>
  );
};
