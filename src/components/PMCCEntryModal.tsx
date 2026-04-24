/**
 * PMCCEntryModal — manual entry form for a PMCC diagonal position.
 *
 * Matches the sealed F1 config (strategy-pmcc-qqq-pt60-f1.ts):
 *   - Long LEAP call at δ 0.70-0.80, DTE 240-300
 *   - Short monthly call at δ 0.20-0.30, DTE 30-45
 *   - Net debit = long LEAP debit − short credit received
 *   - Max loss = LEAP debit × 100 × qty (short legs are rolled indefinitely)
 *   - Capital tier $10K (pmccCapital.startingCapital)
 *
 * User inputs each leg's strike, expiry, and fill price. The form computes
 * net debit, max loss, and suggested contract count based on the pmccCapital
 * allocation. Two separate expiry fields are required because PMCC's two
 * legs live on different expiration dates.
 */
import React, { useState, useMemo } from 'react';
import { X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAppSettings } from '../context/AppSettingsContext';
import { useAddDirect } from '../hooks/usePositionMutations';
import { STRATEGY_PROFILES } from '../lib/strategyProfiles';
import type { PositionLeg } from '../lib/types';
import { CONTRACT_MULTIPLIER } from '../lib/utils';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const PMCCEntryModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { settings } = useAppSettings();
  const addDirect = useAddDirect();
  const profile = STRATEGY_PROFILES.pmcc;

  const capital = settings.pmccCapital?.startingCapital ?? 10000;
  const riskPct = settings.pmccCapital?.riskPctPerTrade ?? 50;
  const budget = capital * (riskPct / 100);

  const [ticker, setTicker] = useState(profile.tickers?.[0] ?? 'QQQ');
  // Long LEAP leg
  const [longExpiration, setLongExpiration] = useState('');
  const [longStrike, setLongStrike] = useState('');
  const [longDebit, setLongDebit] = useState('');
  // Short leg
  const [shortExpiration, setShortExpiration] = useState('');
  const [shortStrike, setShortStrike] = useState('');
  const [shortCredit, setShortCredit] = useState('');

  const [quantityOverride, setQuantityOverride] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const longStrikeNum = parseFloat(longStrike);
  const shortStrikeNum = parseFloat(shortStrike);
  const longDebitNum = parseFloat(longDebit);
  const shortCreditNum = parseFloat(shortCredit);

  const netDebit = !isNaN(longDebitNum) && !isNaN(shortCreditNum)
    ? longDebitNum - shortCreditNum
    : null;
  const maxLossPerContract = !isNaN(longDebitNum) ? longDebitNum * CONTRACT_MULTIPLIER : null;
  const suggestedContracts = maxLossPerContract != null && maxLossPerContract > 0
    ? Math.max(1, Math.floor(budget / maxLossPerContract))
    : 0;
  const contracts = quantityOverride ? parseInt(quantityOverride) : suggestedContracts;

  const longDte = useMemo(() => longExpiration
    ? Math.round((new Date(longExpiration + 'T00:00:00').getTime() - Date.now()) / 86400000)
    : null, [longExpiration]);
  const shortDte = useMemo(() => shortExpiration
    ? Math.round((new Date(shortExpiration + 'T00:00:00').getTime() - Date.now()) / 86400000)
    : null, [shortExpiration]);

  const longDteInRange = longDte != null
    && longDte >= (profile.longDteMin ?? 240)
    && longDte <= (profile.longDteMax ?? 300);
  const shortDteInRange = shortDte != null
    && shortDte >= (profile.shortDteMin ?? 30)
    && shortDte <= (profile.shortDteMax ?? 45);

  const canSubmit = ticker && longExpiration && shortExpiration
    && !isNaN(longStrikeNum) && !isNaN(shortStrikeNum)
    && !isNaN(longDebitNum) && !isNaN(shortCreditNum)
    && shortStrikeNum > longStrikeNum
    && contracts > 0;

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const legs: PositionLeg[] = [
        { strike: longStrikeNum, type: 'Call', side: 'long', expiration: longExpiration },
        { strike: shortStrikeNum, type: 'Call', side: 'short', expiration: shortExpiration },
      ];
      await addDirect.mutateAsync({
        ticker,
        strike: longStrikeNum,
        type: 'PMCC Diagonal',
        // Top-level expiration is the LONG leg (LEAP) — for sorting/display.
        // Leg-level expirations carry the true per-leg dates.
        expiration: longExpiration,
        setup: 'PMCC QQQ pt60 F1',
        strategy: 'PMCC Diagonal',
        strategy_type: 'pmcc',
        direction: 'BULL',
        entry_score: 0,
        // entry_price is the NET debit paid (long leg debit − short credit).
        entry_price: netDebit ?? 0,
        quantity: contracts,
        max_risk_entry: maxLossPerContract ?? undefined,
        trade_profile: 'diagonal',
        is_paper: true,
        target_price: profile.longProfitTarget ?? 0.60,
        legs,
      });
      onClose();
      setLongExpiration('');
      setLongStrike('');
      setLongDebit('');
      setShortExpiration('');
      setShortStrike('');
      setShortCredit('');
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
      aria-label="Enter PMCC diagonal position"
    >
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="card-glass-elevated w-full max-w-lg sm:rounded-2xl rounded-t-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Open PMCC Position</h3>
            <p className="text-[11px] text-text-tertiary mt-0.5">
              {profile.subtitle}
            </p>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-secondary p-1" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 pb-5 space-y-4">
          <div>
            <label className="block text-[11px] font-semibold text-text-tertiary uppercase tracking-wider mb-1">Ticker</label>
            <input
              className="input-field"
              value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              required
            />
          </div>

          {/* Long LEAP leg */}
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/[0.03] px-3 py-3">
            <p className="text-[11px] font-semibold text-blue-400 uppercase tracking-wider mb-2">
              Long LEAP leg · δ {profile.longDeltaMin?.toFixed(2)}–{profile.longDeltaMax?.toFixed(2)}
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[10px] text-text-tertiary mb-1">
                  Expiration
                  {longDte != null && (
                    <span className={`ml-1 text-[9px] font-mono px-1 py-0.5 rounded ${longDteInRange ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                      {longDte}d
                    </span>
                  )}
                </label>
                <input
                  type="date"
                  className="input-field text-xs"
                  value={longExpiration}
                  onChange={e => setLongExpiration(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-[10px] text-text-tertiary mb-1">Strike</label>
                <input
                  type="number"
                  step="0.5"
                  className="input-field text-xs"
                  placeholder="e.g. 400"
                  value={longStrike}
                  onChange={e => setLongStrike(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-[10px] text-text-tertiary mb-1">Debit paid</label>
                <input
                  type="number"
                  step="0.01"
                  className="input-field text-xs"
                  placeholder="e.g. 95.50"
                  value={longDebit}
                  onChange={e => setLongDebit(e.target.value)}
                  required
                />
              </div>
            </div>
          </div>

          {/* Short leg */}
          <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.03] px-3 py-3">
            <p className="text-[11px] font-semibold text-rose-400 uppercase tracking-wider mb-2">
              Short monthly leg · δ {profile.shortDeltaMin?.toFixed(2)}–{profile.shortDeltaMax?.toFixed(2)}
            </p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[10px] text-text-tertiary mb-1">
                  Expiration
                  {shortDte != null && (
                    <span className={`ml-1 text-[9px] font-mono px-1 py-0.5 rounded ${shortDteInRange ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
                      {shortDte}d
                    </span>
                  )}
                </label>
                <input
                  type="date"
                  className="input-field text-xs"
                  value={shortExpiration}
                  onChange={e => setShortExpiration(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-[10px] text-text-tertiary mb-1">Strike</label>
                <input
                  type="number"
                  step="0.5"
                  className="input-field text-xs"
                  placeholder="e.g. 510"
                  value={shortStrike}
                  onChange={e => setShortStrike(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-[10px] text-text-tertiary mb-1">Credit received</label>
                <input
                  type="number"
                  step="0.01"
                  className="input-field text-xs"
                  placeholder="e.g. 3.80"
                  value={shortCredit}
                  onChange={e => setShortCredit(e.target.value)}
                  required
                />
              </div>
            </div>
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

          {/* Summary strip */}
          {netDebit != null && maxLossPerContract != null && contracts > 0 && (
            <div className="rounded-lg bg-bg-secondary/30 border border-border-default/30 px-3 py-2.5 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-text-tertiary">Net debit / contract</span>
                <span className="text-text-primary font-mono">${netDebit.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-tertiary">Max loss (LEAP cost)</span>
                <span className="text-accent-red font-mono">${(maxLossPerContract * contracts).toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-tertiary">Long PT (+{((profile.longProfitTarget ?? 0.60) * 100).toFixed(0)}%)</span>
                <span className="text-accent-green font-mono">
                  +${(maxLossPerContract * (profile.longProfitTarget ?? 0.60) * contracts).toFixed(0)}
                </span>
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
              {submitting ? 'Opening...' : 'Open PMCC Position'}
            </button>
          </div>

          <p className="text-[10px] text-text-tertiary">
            Entered as paper trade by default. Short leg rolls are tracked as roll transactions in Phase D.
          </p>
        </form>
      </motion.div>
    </motion.div>
  );
};
