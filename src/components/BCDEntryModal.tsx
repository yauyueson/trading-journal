/**
 * BCDEntryModal — manual entry form for a BCD bull-call-debit spread position.
 *
 * Matches the sealed F1 config (strategy-bcd-qqq-wide-f1.ts):
 *   - Long call at δ ≈ 0.50
 *   - Short call at δ ≈ 0.20
 *   - Same expiry, DTE 30-60
 *   - Net debit = long debit − short credit
 *   - Capital tier $2K (bcdCapital.startingCapital)
 *
 * The user supplies the long/short strikes and the net debit observed at
 * their broker; the form computes spread width, max loss (= debit × 100 × qty),
 * and suggested contract count based on the bcdCapital.riskPctPerTrade
 * allocation. No chain-scanning dependency — fits the Phase B/C "manual entry
 * + auto tracking" scope.
 */
import React, { useState, useMemo } from 'react';
import { Sparkles, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAppSettings } from '../context/AppSettingsContext';
import { useAddDirect } from '../hooks/usePositionMutations';
import { useChainCandidates } from '../hooks/useChainCandidates';
import { STRATEGY_PROFILES } from '../lib/strategyProfiles';
import type { PositionLeg } from '../lib/types';
import { CONTRACT_MULTIPLIER, formatDate } from '../lib/utils';
import { buildBCDCandidates, type BCDCandidate } from '../lib/chainCandidates';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const BCDEntryModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { settings } = useAppSettings();
  const addDirect = useAddDirect();
  const profile = STRATEGY_PROFILES.bcd;

  const capital = settings.bcdCapital?.startingCapital ?? 2000;
  const riskPct = settings.bcdCapital?.riskPctPerTrade ?? 15;
  const budget = capital * (riskPct / 100);

  const [ticker, setTicker] = useState(profile.tickers?.[0] ?? 'QQQ');
  const [expiration, setExpiration] = useState('');
  const [longStrike, setLongStrike] = useState('');
  const [shortStrike, setShortStrike] = useState('');
  const [netDebit, setNetDebit] = useState('');
  const [quantityOverride, setQuantityOverride] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pickedExpiration, setPickedExpiration] = useState<string | null>(null);

  // Fetch call-chain candidates at δ 0.15-0.55 across DTE 30-60 so we can
  // propose both long (≈ 0.50) and short (≈ 0.20) legs per expiration.
  const chainQuery = useChainCandidates(isOpen && ticker ? {
    ticker,
    direction: 'call',
    strategy: 'long',
    dteMin: profile.dteMin,
    dteMax: profile.dteMax,
    minDelta: 0.15,
    maxDelta: 0.55,
    strikeRange: 0.25,
    minVolume: 0,
  } : null);
  const bcdCandidates: BCDCandidate[] = useMemo(
    () => buildBCDCandidates(chainQuery.data ?? [], profile.defaultDelta, 0.20).slice(0, 5),
    [chainQuery.data, profile.defaultDelta],
  );

  const applyCandidate = (c: BCDCandidate) => {
    setExpiration(c.expiration);
    setLongStrike(String(c.long.strike));
    setShortStrike(String(c.short.strike));
    setNetDebit(c.netDebit.toFixed(2));
    setPickedExpiration(c.expiration);
  };

  const longStrikeNum = parseFloat(longStrike);
  const shortStrikeNum = parseFloat(shortStrike);
  const debitNum = parseFloat(netDebit);
  const width = !isNaN(longStrikeNum) && !isNaN(shortStrikeNum)
    ? Math.abs(shortStrikeNum - longStrikeNum)
    : null;
  const maxLossPerContract = !isNaN(debitNum) ? debitNum * CONTRACT_MULTIPLIER : null;
  const maxProfitPerContract = width != null && !isNaN(debitNum)
    ? (width - debitNum) * CONTRACT_MULTIPLIER
    : null;
  const suggestedContracts = maxLossPerContract != null && maxLossPerContract > 0
    ? Math.max(1, Math.floor(budget / maxLossPerContract))
    : 0;
  const contracts = quantityOverride ? parseInt(quantityOverride) : suggestedContracts;

  const dte = useMemo(() => {
    if (!expiration) return null;
    return Math.round((new Date(expiration + 'T00:00:00').getTime() - Date.now()) / 86400000);
  }, [expiration]);
  const dteInRange = dte != null && dte >= profile.dteMin && dte <= profile.dteMax;

  const canSubmit = ticker && expiration && !isNaN(longStrikeNum) && !isNaN(shortStrikeNum)
    && !isNaN(debitNum) && contracts > 0 && width != null && width > 0
    && longStrikeNum < shortStrikeNum;

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const legs: PositionLeg[] = [
        { strike: longStrikeNum, type: 'Call', side: 'long', expiration },
        { strike: shortStrikeNum, type: 'Call', side: 'short', expiration },
      ];
      await addDirect.mutateAsync({
        ticker,
        strike: longStrikeNum,
        type: 'Debit Call Spread',
        expiration,
        setup: 'BCD QQQ wide F1',
        strategy: 'Bull Call Debit Spread',
        strategy_type: 'bcd',
        direction: 'BULL',
        entry_score: 0,
        entry_price: debitNum,
        quantity: contracts,
        spread_width: width ?? undefined,
        max_risk_entry: maxLossPerContract ?? undefined,
        trade_profile: 'debit_spread',
        is_paper: true,
        target_price: profile.profitTarget,
        legs,
      });
      onClose();
      // reset
      setExpiration('');
      setLongStrike('');
      setShortStrike('');
      setNetDebit('');
      setQuantityOverride('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Enter BCD bull call debit spread position"
    >
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="card-glass-elevated w-full max-w-md sm:rounded-2xl rounded-t-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Open BCD Position</h3>
            <p className="text-[11px] text-text-tertiary mt-0.5">
              {profile.subtitle}
            </p>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-secondary p-1" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 pb-5 space-y-4">
          {/* Suggestions — one candidate spread per expiration in the 30-60 DTE window. */}
          <div className="rounded-lg bg-bg-secondary/40 border border-border-default/30 px-3 py-2.5">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-text-secondary">
                <Sparkles size={12} className="text-accent-green" />
                Suggested spreads
              </div>
              {chainQuery.isFetching && (
                <span className="text-[10px] text-text-tertiary">Loading chain…</span>
              )}
            </div>
            {chainQuery.isError && (
              <p className="text-[11px] text-amber-400">
                Couldn't load chain — enter strikes manually below.
              </p>
            )}
            {!chainQuery.isFetching && !chainQuery.isError && bcdCandidates.length === 0 && (
              <p className="text-[11px] text-text-tertiary">
                No spreads matched — broaden the DTE/δ window or enter manually.
              </p>
            )}
            {bcdCandidates.length > 0 && (
              <div className="space-y-1.5">
                {bcdCandidates.map(c => {
                  const isPicked = pickedExpiration === c.expiration;
                  return (
                    <button
                      key={c.expiration}
                      type="button"
                      onClick={() => applyCandidate(c)}
                      className={`w-full text-left rounded-md px-2.5 py-2 text-[11px] transition-colors ${isPicked ? 'bg-accent-green/15 border border-accent-green/50' : 'bg-bg-tertiary/40 border border-transparent hover:border-border-default/50'}`}
                    >
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="font-mono text-text-primary">{formatDate(c.expiration)} · {c.dte}d</span>
                        <span className="font-mono text-accent-green">${c.netDebit.toFixed(2)}/ct</span>
                      </div>
                      <div className="flex items-center justify-between text-text-tertiary">
                        <span>
                          L ${c.long.strike} δ{Math.abs(c.long.greeks.delta).toFixed(2)}
                          {' · '}
                          S ${c.short.strike} δ{Math.abs(c.short.greeks.delta).toFixed(2)}
                        </span>
                        <span className="font-mono">w ${c.width.toFixed(0)}</span>
                      </div>
                    </button>
                  );
                })}
                <p className="text-[10px] text-text-tertiary pt-1">
                  Mid-price estimates — verify fill at your broker before submitting.
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-1">Ticker</label>
              <input
                className="input-field"
                value={ticker}
                onChange={e => setTicker(e.target.value.toUpperCase())}
                required
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-1">
                Expiration
                {dte != null && (
                  <span className={`ml-2 text-[9px] font-mono px-1.5 py-0.5 rounded ${dteInRange ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                    {dte}d{!dteInRange && ' ⚠'}
                  </span>
                )}
              </label>
              <input
                type="date"
                className="input-field"
                value={expiration}
                onChange={e => setExpiration(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-1">
                Long strike · δ ≈ {profile.defaultDelta.toFixed(2)}
              </label>
              <input
                type="number"
                step="0.5"
                className="input-field"
                placeholder="e.g. 490"
                value={longStrike}
                onChange={e => setLongStrike(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-1">
                Short strike · δ ≈ 0.20
              </label>
              <input
                type="number"
                step="0.5"
                className="input-field"
                placeholder="e.g. 510"
                value={shortStrike}
                onChange={e => setShortStrike(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-1">
                Net debit / contract
              </label>
              <input
                type="number"
                step="0.01"
                className="input-field"
                placeholder="e.g. 4.20"
                value={netDebit}
                onChange={e => setNetDebit(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-1">
                Contracts <span className="text-text-tertiary/70 normal-case font-normal">(suggested {suggestedContracts})</span>
              </label>
              <input
                type="number"
                step="1"
                min="1"
                className="input-field"
                placeholder={String(suggestedContracts || 1)}
                value={quantityOverride}
                onChange={e => setQuantityOverride(e.target.value)}
              />
            </div>
          </div>

          {/* Summary strip */}
          {width != null && maxLossPerContract != null && maxProfitPerContract != null && contracts > 0 && (
            <div className="rounded-lg bg-bg-secondary/30 border border-border-default/30 px-3 py-2.5 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-text-tertiary">Spread width</span>
                <span className="text-text-primary font-mono">${width.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-tertiary">Max loss</span>
                <span className="text-accent-red font-mono">${(maxLossPerContract * contracts).toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-tertiary">Max profit (PT 50%)</span>
                <span className="text-accent-green font-mono">${(maxProfitPerContract * 0.5 * contracts).toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-tertiary">% of capital</span>
                <span className="text-text-primary font-mono">
                  {capital > 0 ? ((maxLossPerContract * contracts / capital) * 100).toFixed(1) : '—'}%
                </span>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="action-btn btn-secondary text-xs"
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="action-btn btn-primary text-xs"
              disabled={!canSubmit || submitting}
            >
              {submitting ? 'Opening...' : 'Open BCD Position'}
            </button>
          </div>

          <p className="text-[10px] text-text-tertiary">
            Entered as paper trade by default. Mark live from the position card when real.
          </p>
        </form>
      </motion.div>
    </motion.div>
  );
};
