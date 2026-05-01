import React, { useMemo, useState } from 'react';
import { usePositions } from '../hooks/usePositions';
import { ACTIVE_STRATEGIES, STRATEGY_PROFILES, type StrategyType } from '../lib/strategyProfiles';
import { BCDEntryModal } from '../components/BCDEntryModal';
import { PMCCEntryModal } from '../components/PMCCEntryModal';

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
  const [entryModal, setEntryModal] = useState<StrategyType | null>(null);

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
          <h1 className="text-xl sm:text-2xl font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">▌ SIGNALS</h1>
          <p className="text-[11px] text-text-tertiary font-mono uppercase tracking-wider mt-1">ACTIVE STRATEGIES // ENTER VIA PORTFOLIO TAB</p>
        </div>
      </div>

      {/* Strategy tabs */}
      <div className="flex items-center gap-2 mb-6 border-b border-phosphor-green/15">
        {ACTIVE_STRATEGIES.map(s => {
          const profile = STRATEGY_PROFILES[s];
          const isActive = activeBoard === s;
          return (
            <button
              key={s}
              onClick={() => setActiveBoard(s)}
              className={`px-4 py-2 text-[11px] font-mono uppercase tracking-wider border-b-2 transition-colors cursor-pointer ${
                isActive
                  ? 'border-phosphor-green text-phosphor-green text-glow-green'
                  : 'border-transparent text-text-tertiary hover:text-phosphor-dim'
              }`}
            >
              {profile.shortLabel}
            </button>
          );
        })}
      </div>

      {/* Board content */}
      <div className="terminal-panel p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-text-primary font-mono font-bold uppercase tracking-wider text-base">{boardContext.profile.label}</h2>
            <p className="text-[11px] text-text-tertiary font-mono mt-1">{boardContext.profile.subtitle}</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-mono font-bold tracking-wider uppercase ${
            boardContext.openPosition
              ? 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/40'
              : boardContext.primaryStatus === 'Eligible'
                ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40'
                : 'bg-terminal-panel text-text-tertiary border border-phosphor-green/20'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              boardContext.openPosition ? 'bg-phosphor-amber pulse-glow' : boardContext.primaryStatus === 'Eligible' ? 'bg-phosphor-green pulse-glow' : 'bg-text-tertiary/30'
            }`} />
            {boardContext.primaryStatus === 'In trade' ? 'OPEN' : boardContext.primaryStatus === 'Eligible' ? 'READY' : 'WAITING'}
          </span>
        </div>

        <p className="text-sm text-text-secondary font-mono mb-6">{boardContext.statusDetail}</p>

        {/* Strategy params */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs">
          <div>
            <p className="label-mono mb-1">UNIVERSE</p>
            <p className="text-text-primary font-mono tabular-nums">{boardContext.profile.tickers?.join(', ') ?? 'QQQ'}</p>
          </div>
          {boardContext.profile.kind === 'debit_spread' && (
            <>
              <div>
                <p className="label-mono mb-1">LONG δ / SHORT δ</p>
                <p className="text-text-primary font-mono tabular-nums">
                  {boardContext.profile.defaultDelta.toFixed(2)} / {(0.20).toFixed(2)}
                </p>
              </div>
              <div>
                <p className="label-mono mb-1">DTE RANGE</p>
                <p className="text-text-primary font-mono tabular-nums">{boardContext.profile.dteMin}-{boardContext.profile.dteMax}d</p>
              </div>
              <div>
                <p className="label-mono mb-1">PROFIT TARGET</p>
                <p className="text-text-primary font-mono tabular-nums">+{(boardContext.profile.profitTarget * 100).toFixed(0)}%</p>
              </div>
              <div>
                <p className="label-mono mb-1">CADENCE</p>
                <p className="text-text-primary font-mono">Every 10 trading days</p>
              </div>
              <div>
                <p className="label-mono mb-1">SIGNAL</p>
                <p className="text-text-primary font-mono">No timing filter</p>
              </div>
            </>
          )}
          {boardContext.profile.kind === 'diagonal' && (
            <>
              <div>
                <p className="label-mono mb-1">LONG δ RANGE</p>
                <p className="text-text-primary font-mono tabular-nums">
                  {boardContext.profile.longDeltaMin?.toFixed(2)}–{boardContext.profile.longDeltaMax?.toFixed(2)}
                </p>
              </div>
              <div>
                <p className="label-mono mb-1">LONG DTE RANGE</p>
                <p className="text-text-primary font-mono tabular-nums">{boardContext.profile.longDteMin}–{boardContext.profile.longDteMax}d</p>
              </div>
              <div>
                <p className="label-mono mb-1">SHORT δ RANGE</p>
                <p className="text-text-primary font-mono tabular-nums">
                  {boardContext.profile.shortDeltaMin?.toFixed(2)}–{boardContext.profile.shortDeltaMax?.toFixed(2)}
                </p>
              </div>
              <div>
                <p className="label-mono mb-1">SHORT DTE RANGE</p>
                <p className="text-text-primary font-mono tabular-nums">{boardContext.profile.shortDteMin}–{boardContext.profile.shortDteMax}d</p>
              </div>
              <div>
                <p className="label-mono mb-1">LONG PT / SL</p>
                <p className="text-text-primary font-mono tabular-nums">
                  +{((boardContext.profile.longProfitTarget ?? 0) * 100).toFixed(0)}% / −{((boardContext.profile.longStopLoss ?? 0) * 100).toFixed(0)}%
                </p>
              </div>
              <div>
                <p className="label-mono mb-1">SHORT PT / ROLL</p>
                <p className="text-text-primary font-mono tabular-nums">
                  +{((boardContext.profile.shortProfitTarget ?? 0) * 100).toFixed(0)}% / {((boardContext.profile.rollTriggerMoneyness ?? 0.02) * 100).toFixed(0)}% moneyness
                </p>
              </div>
            </>
          )}
        </div>

        {/* Enter button */}
        {!boardContext.openPosition && (
          <div className="mt-6 pt-4 border-t border-phosphor-green/15 flex items-center justify-between">
            <p className="text-[11px] text-text-tertiary font-mono">
              Manual entry. Enter strikes + fills from your broker; the platform tracks P&L, rolls, and exit triggers.
            </p>
            <button
              type="button"
              onClick={() => setEntryModal(activeBoard)}
              className="btn-terminal whitespace-nowrap"
            >
              ▌ OPEN {boardContext.profile.shortLabel} →
            </button>
          </div>
        )}
      </div>

      <BCDEntryModal
        isOpen={entryModal === 'bcd'}
        onClose={() => setEntryModal(null)}
      />
      <PMCCEntryModal
        isOpen={entryModal === 'pmcc'}
        onClose={() => setEntryModal(null)}
      />
    </div>
  );
};
