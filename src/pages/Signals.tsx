import React, { useState } from 'react';
import { useStrategyStatus } from '../hooks/useStrategyStatus';
import { ACTIVE_STRATEGIES, STRATEGY_PROFILES, type StrategyType } from '../lib/strategyProfiles';
import { BCDEntryModal } from '../components/BCDEntryModal';
import { PMCCEntryModal } from '../components/PMCCEntryModal';

export const SignalsPage: React.FC = () => {
  const statuses = useStrategyStatus();
  const [activeBoard, setActiveBoard] = useState<StrategyType>(ACTIVE_STRATEGIES[0]);
  const [entryModal, setEntryModal] = useState<StrategyType | null>(null);

  const status = statuses.find(s => s.strategy === activeBoard) ?? statuses[0];
  const profile = status.profile;

  const primaryStatusLabel =
    status.state === 'open' ? 'In trade' : status.state === 'ready' ? 'Eligible' : 'Waiting';

  const statusDetail = (() => {
    if (status.state === 'open' && status.openPosition) {
      const date = status.openSinceDate ?? '?';
      if (activeBoard === 'pmcc') {
        const pct = ((profile.rollTriggerMoneyness ?? 0.02) * 100).toFixed(0);
        return `Open since ${date}. Roll short leg when underlying within ${pct}% of short strike.`;
      }
      return `Open since ${date}.`;
    }
    if (activeBoard === 'pmcc') {
      return 'Always-in — enter long LEAP + short monthly when portfolio is flat.';
    }
    // BCD flat
    if (status.tradingDaysSince == null || status.nextEmissionDate == null) {
      return 'No prior history. Ready to enter on next trading day.';
    }
    return `${status.tradingDaysSince} trading days since last close. Next emission: ${status.nextEmissionDate}`;
  })();

  return (
    <div className="max-w-5xl mx-auto stagger-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">▌ SIGNALS</h1>
          <p className="text-[11px] text-text-tertiary font-mono uppercase tracking-wider mt-1">STRATEGY SPEC // PARAMETERS &amp; CADENCE</p>
        </div>
      </div>

      {/* Strategy tabs */}
      <div className="flex items-center gap-2 mb-6 border-b border-phosphor-green/15">
        {ACTIVE_STRATEGIES.map(s => {
          const p = STRATEGY_PROFILES[s];
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
              {p.shortLabel}
            </button>
          );
        })}
      </div>

      {/* Board content */}
      <div className="terminal-panel p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-text-primary font-mono font-bold uppercase tracking-wider text-base">{profile.label}</h2>
            <p className="text-[11px] text-text-tertiary font-mono mt-1">{profile.subtitle}</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-mono font-bold tracking-wider uppercase ${
            status.state === 'open'
              ? 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/40'
              : status.state === 'ready'
                ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40'
                : 'bg-terminal-panel text-text-tertiary border border-phosphor-green/20'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              status.state === 'open' ? 'bg-phosphor-amber pulse-glow' : status.state === 'ready' ? 'bg-phosphor-green pulse-glow' : 'bg-text-tertiary/30'
            }`} />
            {primaryStatusLabel === 'In trade' ? 'OPEN' : primaryStatusLabel === 'Eligible' ? 'READY' : 'WAITING'}
          </span>
        </div>

        <p className="text-sm text-text-secondary font-mono mb-6">{statusDetail}</p>

        {/* Strategy params */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs">
          <div>
            <p className="label-mono mb-1">UNIVERSE</p>
            <p className="text-text-primary font-mono tabular-nums">{profile.tickers?.join(', ') ?? 'QQQ'}</p>
          </div>
          {profile.kind === 'debit_spread' && (
            <>
              <div>
                <p className="label-mono mb-1">LONG δ / SHORT δ</p>
                <p className="text-text-primary font-mono tabular-nums">
                  {profile.defaultDelta.toFixed(2)} / {(0.20).toFixed(2)}
                </p>
              </div>
              <div>
                <p className="label-mono mb-1">DTE RANGE</p>
                <p className="text-text-primary font-mono tabular-nums">{profile.dteMin}-{profile.dteMax}d</p>
              </div>
              <div>
                <p className="label-mono mb-1">PROFIT TARGET</p>
                <p className="text-text-primary font-mono tabular-nums">+{(profile.profitTarget * 100).toFixed(0)}%</p>
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
          {profile.kind === 'diagonal' && (
            <>
              <div>
                <p className="label-mono mb-1">LONG δ RANGE</p>
                <p className="text-text-primary font-mono tabular-nums">
                  {profile.longDeltaMin?.toFixed(2)}–{profile.longDeltaMax?.toFixed(2)}
                </p>
              </div>
              <div>
                <p className="label-mono mb-1">LONG DTE RANGE</p>
                <p className="text-text-primary font-mono tabular-nums">{profile.longDteMin}–{profile.longDteMax}d</p>
              </div>
              <div>
                <p className="label-mono mb-1">SHORT δ RANGE</p>
                <p className="text-text-primary font-mono tabular-nums">
                  {profile.shortDeltaMin?.toFixed(2)}–{profile.shortDeltaMax?.toFixed(2)}
                </p>
              </div>
              <div>
                <p className="label-mono mb-1">SHORT DTE RANGE</p>
                <p className="text-text-primary font-mono tabular-nums">{profile.shortDteMin}–{profile.shortDteMax}d</p>
              </div>
              <div>
                <p className="label-mono mb-1">LONG PT / SL</p>
                <p className="text-text-primary font-mono tabular-nums">
                  +{((profile.longProfitTarget ?? 0) * 100).toFixed(0)}% / −{((profile.longStopLoss ?? 0) * 100).toFixed(0)}%
                </p>
              </div>
              <div>
                <p className="label-mono mb-1">SHORT PT / ROLL</p>
                <p className="text-text-primary font-mono tabular-nums">
                  +{((profile.shortProfitTarget ?? 0) * 100).toFixed(0)}% / {((profile.rollTriggerMoneyness ?? 0.02) * 100).toFixed(0)}% moneyness
                </p>
              </div>
            </>
          )}
        </div>

        {/* Enter button */}
        {status.state !== 'open' && (
          <div className="mt-6 pt-4 border-t border-phosphor-green/15 flex items-center justify-between">
            <p className="text-[11px] text-text-tertiary font-mono">
              Manual entry. Enter strikes + fills from your broker; the platform tracks P&amp;L, rolls, and exit triggers.
            </p>
            <button
              type="button"
              onClick={() => setEntryModal(activeBoard)}
              className="btn-terminal whitespace-nowrap"
            >
              ▌ OPEN {profile.shortLabel} →
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
