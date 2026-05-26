/**
 * BCDEntryModal — manual entry form for a BCD bull-call-debit spread position.
 *
 * Matches the sealed F1 config (strategy-bcd-qqq-wide-f1.ts):
 *   - Long call at δ ≈ 0.50
 *   - Short call at δ ≈ 0.20
 *   - Same expiry, DTE 30-60
 *   - Net debit = long debit − short credit
 *   - Capital tier $5K (bcdCapital.startingCapital)
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
import { buildBcdFillDiagnostics } from '../lib/fillDiagnostics';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const BCDEntryModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { settings } = useAppSettings();
  const addDirect = useAddDirect();
  const profile = STRATEGY_PROFILES.bcd;

  const capital = settings.bcdCapital?.startingCapital ?? 5000;
  const riskPct = settings.bcdCapital?.riskPctPerTrade ?? 30;
  const budget = capital * (riskPct / 100);

  const [ticker, setTicker] = useState(profile.tickers?.[0] ?? 'QQQ');
  const [expiration, setExpiration] = useState('');
  const [longStrike, setLongStrike] = useState('');
  const [shortStrike, setShortStrike] = useState('');
  const [longDebit, setLongDebit] = useState('');
  const [shortCredit, setShortCredit] = useState('');
  const [quantityOverride, setQuantityOverride] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pickedExpiration, setPickedExpiration] = useState<string | null>(null);

  // Fetch the long (δ ≈ 0.50) and short (δ ≈ 0.20) legs in two narrow-band
  // queries instead of one wide [0.15, 0.55] sweep. The /api/scan-options
  // endpoint truncates its response to the top 20 contracts ranked by LQS
  // (api/scan-options.js:386), and a broad-band BCD scan was getting the
  // δ ≤ 0.25 strikes pruned out before reaching buildBCDCandidates — leaving
  // the modal to settle for δ 0.30-0.40 shorts and present spreads that
  // didn't match the F1 sealed config. Two narrow bands fit comfortably
  // under the 20-cap and surface the right contracts on both legs.
  const longChainQuery = useChainCandidates(isOpen && ticker ? {
    ticker,
    direction: 'call',
    strategy: 'long',
    dteMin: profile.dteMin,
    dteMax: profile.dteMax,
    minDelta: 0.45,
    maxDelta: 0.55,
    strikeRange: 0.25,
    minVolume: 0,
  } : null);
  const shortChainQuery = useChainCandidates(isOpen && ticker ? {
    ticker,
    direction: 'call',
    strategy: 'long',
    dteMin: profile.dteMin,
    dteMax: profile.dteMax,
    minDelta: 0.15,
    maxDelta: 0.25,
    strikeRange: 0.25,
    minVolume: 0,
  } : null);
  const mergedChain = useMemo(
    () => [...(longChainQuery.data ?? []), ...(shortChainQuery.data ?? [])],
    [longChainQuery.data, shortChainQuery.data],
  );
  const bcdCandidates: BCDCandidate[] = useMemo(
    () => buildBCDCandidates(mergedChain, profile.defaultDelta, 0.20).slice(0, 5),
    [mergedChain, profile.defaultDelta],
  );

  const applyCandidate = (c: BCDCandidate) => {
    setExpiration(c.expiration);
    setLongStrike(String(c.long.strike));
    setShortStrike(String(c.short.strike));
    setLongDebit(c.long.price.toFixed(2));
    setShortCredit(c.short.price.toFixed(2));
    setPickedExpiration(c.expiration);
  };

  const longStrikeNum = parseFloat(longStrike);
  const shortStrikeNum = parseFloat(shortStrike);
  const longDebitNum = parseFloat(longDebit);
  const shortCreditNum = parseFloat(shortCredit);
  const debitNum = !isNaN(longDebitNum) && !isNaN(shortCreditNum)
    ? longDebitNum - shortCreditNum
    : NaN;
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
    && !isNaN(longDebitNum) && longDebitNum > 0
    && !isNaN(shortCreditNum) && shortCreditNum >= 0
    && debitNum > 0
    && contracts > 0 && width != null && width > 0
    && longStrikeNum < shortStrikeNum;

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const legs: PositionLeg[] = [
        { strike: longStrikeNum, type: 'Call', side: 'long', expiration, openedDebit: longDebitNum, cycleQty: contracts },
        { strike: shortStrikeNum, type: 'Call', side: 'short', expiration, openedCredit: shortCreditNum, cycleQty: contracts },
      ];
      const fetchedAtMs = Math.max(longChainQuery.dataUpdatedAt ?? 0, shortChainQuery.dataUpdatedAt ?? 0);
      const fillDiagnostics = buildBcdFillDiagnostics({
        quantity: contracts,
        netDebit: debitNum,
        longStrike: longStrikeNum,
        shortStrike: shortStrikeNum,
        expiration,
        chain: mergedChain,
        chainFetchedAt: fetchedAtMs ? new Date(fetchedAtMs).toISOString() : null,
      });
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
        execution_account_size: capital,
        // target_price: actual dollar target = entry debit × (1 + profit-target%).
        // BCD profit target is on debit paid, so target = debitNum × 1.50 by default.
        target_price: debitNum * (1 + profile.profitTarget),
        legs,
        fill_diagnostics: fillDiagnostics,
      });
      onClose();
      // reset
      setExpiration('');
      setLongStrike('');
      setShortStrike('');
      setLongDebit('');
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
            <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">▌ OPEN_BCD_POSITION</h3>
            <p className="text-[11px] text-text-tertiary font-mono mt-0.5">
              {profile.subtitle}
            </p>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-phosphor-amber p-1 cursor-pointer" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 pb-5 space-y-4">
          {/* Suggestions — one candidate spread per expiration in the 30-60 DTE window. */}
          <div className="terminal-panel px-3 py-2.5">
            <div className="flex items-center justify-between mb-2">
              <div className="label-mono flex items-center gap-1.5">
                <Sparkles size={12} className="text-phosphor-green" />
                ▌ SUGGESTED SPREADS
              </div>
              {(longChainQuery.isFetching || shortChainQuery.isFetching) && (
                <span className="text-[10px] text-phosphor-dim font-mono uppercase tracking-wider">Loading…</span>
              )}
            </div>
            {(longChainQuery.isError || shortChainQuery.isError) && (
              <p className="text-[11px] text-phosphor-amber font-mono">
                Couldn't load chain — enter strikes manually below.
              </p>
            )}
            {!(longChainQuery.isFetching || shortChainQuery.isFetching) && !(longChainQuery.isError || shortChainQuery.isError) && bcdCandidates.length === 0 && (
              <p className="text-[11px] text-text-tertiary font-mono">
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
                      className={`w-full text-left rounded-md px-2.5 py-2 text-[11px] font-mono transition-colors cursor-pointer ${isPicked ? 'bg-phosphor-green/10 border border-phosphor-green/45 text-glow-green' : 'bg-terminal-panel border border-border-default/50 hover:border-phosphor-green/30'}`}
                    >
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="font-mono text-text-primary tabular-nums">{formatDate(c.expiration)} · {c.dte}d</span>
                        <span className="font-mono text-phosphor-green tabular-nums">${c.netDebit.toFixed(2)}/ct</span>
                      </div>
                      <div className="flex items-center justify-between text-text-tertiary tabular-nums">
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
                <p className="text-[10px] text-text-tertiary font-mono pt-1">
                  ▌ Mid-price estimates — verify fill at your broker.
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label-mono mb-1 block">Ticker</label>
              <input
                className="input-field"
                value={ticker}
                onChange={e => setTicker(e.target.value.toUpperCase())}
                required
              />
            </div>
            <div>
              <label className="label-mono mb-1 block">
                Expiration
                {dte != null && (
                  <span className={`ml-2 text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${dteInRange ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/30' : 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/30'}`}>
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
              <label className="label-mono mb-1 block">
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
              <label className="label-mono mb-1 block">
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
              <label className="label-mono mb-1 block">
                Long debit / share
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                className="input-field"
                placeholder="e.g. 5.00"
                value={longDebit}
                onChange={e => setLongDebit(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label-mono mb-1 block">
                Short credit / share
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                className="input-field"
                placeholder="e.g. 0.80"
                value={shortCredit}
                onChange={e => setShortCredit(e.target.value)}
                required
              />
            </div>
          </div>

          <div>
            <label className="label-mono mb-1 block">
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
          {width != null && maxLossPerContract != null && maxProfitPerContract != null && contracts > 0 && (
            <div className="terminal-panel px-3 py-2.5 text-xs font-mono space-y-1">
              <div className="flex justify-between">
                <span className="label-mono">NET DEBIT / SHARE</span>
                <span className="text-text-primary tabular-nums">${debitNum.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="label-mono">SPREAD WIDTH</span>
                <span className="text-text-primary tabular-nums">${width.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="label-mono">MAX LOSS</span>
                <span className="text-phosphor-red text-glow-red tabular-nums">${(maxLossPerContract * contracts).toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="label-mono">MAX PROFIT (PT 50%)</span>
                <span className="text-phosphor-green text-glow-green tabular-nums">${(maxProfitPerContract * 0.5 * contracts).toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="label-mono">% OF CAPITAL</span>
                <span className="text-text-primary tabular-nums">
                  {capital > 0 ? ((maxLossPerContract * contracts / capital) * 100).toFixed(1) : '—'}%
                </span>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-terminal-danger flex-1"
              disabled={submitting}
            >
              CANCEL
            </button>
            <button
              type="submit"
              className="btn-terminal flex-1"
              disabled={!canSubmit || submitting}
            >
              {submitting ? '▌ OPENING...' : '▌ OPEN BCD'}
            </button>
          </div>

          <p className="text-[10px] text-text-tertiary font-mono">
            ▌ Entered as paper by default. Mark live from the position card when real.
          </p>
        </form>
      </motion.div>
    </motion.div>
  );
};
