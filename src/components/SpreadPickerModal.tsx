/**
 * SpreadPickerModal — click a signal, see 3-4 spread recommendations, click to open position.
 * Reusable across Dashboard and Signals pages.
 */
import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAppSettings } from '../context/AppSettingsContext';
import { useAddDirect } from '../hooks/usePositionMutations';
import type { SpreadRecommendation } from '../lib/types';
import { CONTRACT_MULTIPLIER } from '../lib/utils';

interface SignalTarget {
  ticker: string;
  side: 'bull' | 'bear';
  spread: string; // e.g. 'sp30/20'
}

interface SpreadPickerModalProps {
  signal: SignalTarget | null;
  onClose: () => void;
}

function parseDeltaRange(spread: string): { minDelta: string; maxDelta: string } {
  // sp30/20 → short delta 0.30, long delta 0.20 → scan range 0.15-0.35
  // sp40/30 → short delta 0.40, long delta 0.30 → scan range 0.25-0.45
  // sp15/05 → short delta 0.15, long delta 0.05 → scan range 0.03-0.20
  const match = spread.match(/sp(\d+)\/(\d+)/);
  if (!match) return { minDelta: '0.15', maxDelta: '0.35' };
  const short = parseInt(match[1]) / 100;
  const long = parseInt(match[2]) / 100;
  return {
    minDelta: Math.max(0.03, long - 0.05).toFixed(2),
    maxDelta: (short + 0.05).toFixed(2),
  };
}

export function SpreadPickerModal({ signal, onClose }: SpreadPickerModalProps) {
  const { settings } = useAppSettings();
  const addDirect = useAddDirect();
  const [confirming, setConfirming] = useState<SpreadRecommendation | null>(null);

  const capital = settings.dte5Capital?.startingCapital ?? 10000;
  const riskPctPerTrade = settings.dte5Capital?.riskPctPerTrade ?? 10;
  const maxRiskDollars = capital * (riskPctPerTrade / 100);

  const direction = signal?.side === 'bull' ? 'put' : 'call';
  const { minDelta, maxDelta } = signal ? parseDeltaRange(signal.spread) : { minDelta: '0.15', maxDelta: '0.35' };

  const spreadsQuery = useQuery<SpreadRecommendation[]>({
    queryKey: ['spread-picker', signal?.ticker, signal?.side, signal?.spread],
    queryFn: async () => {
      if (!signal) return [];
      const params = new URLSearchParams({
        ticker: signal.ticker,
        direction,
        dteMin: String(settings.creditSpread?.dte5?.dteMin ?? 2),
        dteMax: String(settings.creditSpread?.dte5?.dteMax ?? 7),
        minDelta, maxDelta,
        strategy: 'credit',
      });
      const res = await fetch(`/api/scan-options?${params}`);
      if (!res.ok) throw new Error('Failed');
      const json = await res.json();
      const raw = json.strategies?.TARGET_STRATEGY ?? [];
      // Filter to only valid spread objects (must have shortLeg.strike)
      const spreads = (raw as SpreadRecommendation[]).filter(s => s?.shortLeg?.strike != null);
      return spreads.slice(0, 4);
    },
    enabled: !!signal,
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

  const handleOpen = useCallback(async (spread: SpreadRecommendation) => {
    if (!signal) return;
    const { contracts, maxLoss } = computeSize(spread);
    const credit = spread.netCredit ?? 0;
    const isBull = signal.side === 'bull';
    await addDirect.mutateAsync({
      ticker: signal.ticker,
      strike: spread.shortLeg.strike,
      type: isBull ? 'Put Spread' : 'Call Spread',
      expiration: spread.shortLeg.expiration,
      setup: isBull ? 'DTE5 Bull Put' : 'DTE5 Bear Call',
      strategy: isBull ? 'Bull Put Spread' : 'Bear Call Spread',
      strategy_type: 'dte5',
      direction: isBull ? 'BULL' : 'BEAR',
      entry_score: spread.score ?? 0,
      entry_price: credit,
      quantity: contracts,
      spread_width: spread.width,
      max_risk_entry: maxLoss,
      is_paper: true,
      target_price: 1.0,
      legs: [
        { strike: spread.shortLeg.strike, type: isBull ? 'Put' : 'Call', side: 'short' as const, expiration: spread.shortLeg.expiration },
        { strike: spread.longLeg.strike, type: isBull ? 'Put' : 'Call', side: 'long' as const, expiration: spread.longLeg.expiration },
      ],
    });
    onClose();
  }, [signal, computeSize, addDirect, onClose]);

  const isBull = signal?.side === 'bull';
  const accentColor = isBull ? 'emerald' : 'rose';

  if (!signal) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center modal-overlay"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
        className="card-glass-elevated w-full max-w-md sm:rounded-2xl rounded-t-2xl rounded-b-none sm:rounded-b-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">
              {signal.ticker} {isBull ? 'Bull Put' : 'Bear Call'}
            </h3>
            <p className="text-[11px] text-text-tertiary mt-0.5">
              {signal.spread} · DTE 2-7 · ${maxRiskDollars.toFixed(0)} risk budget
            </p>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-secondary p-1">
            <X size={16} />
          </button>
        </div>

        {/* Spreads list */}
        <div className="px-5 pb-5">
          {spreadsQuery.isLoading && (
            <div className="py-8 text-center">
              <div className="spinner mx-auto mb-2" />
              <p className="text-text-tertiary text-xs">Scanning {signal.ticker} chains...</p>
            </div>
          )}

          {spreadsQuery.isError && (
            <div className="py-6 text-center text-accent-red text-xs">
              Failed to scan options. Try again later.
            </div>
          )}

          {!spreadsQuery.isLoading && !spreadsQuery.isError && spreadsQuery.data && spreadsQuery.data.length === 0 && (
            <div className="py-6 text-center text-text-tertiary text-xs">
              No qualifying spreads found in DTE 2-7 window.
            </div>
          )}

          {/* Confirm view */}
          {confirming ? (() => {
            const { contracts, maxLoss, maxProfit } = computeSize(confirming);
            const credit = confirming.netCredit ?? 0;
            return (
              <div>
                <div className="space-y-2 text-sm mb-4">
                  {[
                    ['Spread', `${confirming.shortLeg.strike}/${confirming.longLeg.strike}`],
                    ['Expiry', confirming.shortLeg.expiration],
                    ['Contracts', String(contracts)],
                    ['Credit', `$${credit.toFixed(2)}`],
                    ['Max Profit', `$${maxProfit.toFixed(0)}`],
                    ['Max Risk', `$${maxLoss.toFixed(0)}`],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between">
                      <span className="text-text-tertiary">{label}</span>
                      <span className={`font-mono ${
                        label === 'Max Risk' ? 'text-accent-red'
                        : label === 'Credit' || label === 'Max Profit' ? 'text-accent-green'
                        : 'text-white'
                      }`}>{value}</span>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button
                    className="action-btn btn-secondary text-xs"
                    onClick={() => setConfirming(null)}
                    disabled={addDirect.isPending}
                  >
                    Back
                  </button>
                  <button
                    className="action-btn btn-primary text-xs"
                    onClick={() => handleOpen(confirming)}
                    disabled={addDirect.isPending}
                  >
                    {addDirect.isPending ? 'Opening...' : 'Open Position'}
                  </button>
                </div>
              </div>
            );
          })() : (
            <div className="space-y-2">
              {spreadsQuery.data?.map((spread, i) => {
                const { contracts, maxLoss } = computeSize(spread);
                const credit = spread.netCredit ?? 0;
                return (
                  <button
                    key={`${spread.shortLeg.strike}-${spread.longLeg.strike}-${i}`}
                    onClick={() => setConfirming(spread)}
                    className={`w-full text-left py-3 px-4 rounded-xl border border-white/[0.06] hover:border-${accentColor}-500/30 hover:bg-white/[0.03] transition-all duration-150`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-white font-semibold text-sm">
                          {spread.shortLeg.strike}/{spread.longLeg.strike}
                        </span>
                        <span className="text-text-tertiary text-xs">{spread.shortLeg.dte}d · {contracts}ct</span>
                      </div>
                      <span className={`font-mono text-sm font-semibold text-${accentColor}-400`}>
                        ${credit.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex gap-4 mt-1 text-[11px] text-text-tertiary font-mono">
                      <span className="text-accent-red">-${maxLoss.toFixed(0)} risk</span>
                      {spread.pop != null && <span>{(spread.pop * 100).toFixed(0)}% POP</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
