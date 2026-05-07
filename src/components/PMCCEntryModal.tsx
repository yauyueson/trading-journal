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
import { Sparkles, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useAppSettings } from '../context/AppSettingsContext';
import { useAddDirect } from '../hooks/usePositionMutations';
import { useChainCandidates } from '../hooks/useChainCandidates';
import { STRATEGY_PROFILES } from '../lib/strategyProfiles';
import type { PositionLeg } from '../lib/types';
import { CONTRACT_MULTIPLIER, formatDate } from '../lib/utils';
import {
  buildPMCCLeapCandidates,
  buildPMCCShortCandidates,
  type ChainOption,
} from '../lib/chainCandidates';
import { buildPmccFillDiagnostics } from '../lib/fillDiagnostics';

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
  const [pickedLeap, setPickedLeap] = useState<ChainOption | null>(null);
  const [pickedShort, setPickedShort] = useState<ChainOption | null>(null);

  // LEAP candidates: δ band matches the sealed F1 config exactly so the
  // /api/scan-options top-20 LQS truncation can't return contracts outside
  // the sealed range — same class of bug that hit BCDEntryModal pre-fix.
  // Liquidity is still relaxed via maxSpreadPct: 0.30 + minVolume: 0; if
  // the chain is genuinely sparse at exact-band edges the modal will show
  // fewer suggestions and the user can enter manually.
  const leapQuery = useChainCandidates(isOpen && ticker ? {
    ticker,
    direction: 'call',
    strategy: 'long',
    dteMin: profile.longDteMin ?? 240,
    dteMax: profile.longDteMax ?? 300,
    minDelta: profile.longDeltaMin ?? 0.70,
    maxDelta: profile.longDeltaMax ?? 0.80,
    strikeRange: 0.5,
    minVolume: 0,
    maxSpreadPct: 0.30,
  } : null);

  const shortQuery = useChainCandidates(isOpen && ticker ? {
    ticker,
    direction: 'call',
    strategy: 'long',
    dteMin: profile.shortDteMin ?? 30,
    dteMax: profile.shortDteMax ?? 45,
    minDelta: profile.shortDeltaMin ?? 0.20,
    maxDelta: profile.shortDeltaMax ?? 0.30,
    strikeRange: 0.25,
    minVolume: 0,
  } : null);

  const leapCandidates = useMemo(
    () => buildPMCCLeapCandidates(leapQuery.data ?? [], 0.75).slice(0, 5),
    [leapQuery.data],
  );
  const shortCandidates = useMemo(() => {
    const manualLong = parseFloat(longStrike);
    const floor = pickedLeap?.strike ?? (isNaN(manualLong) ? 0 : manualLong);
    if (floor <= 0) return [];
    return buildPMCCShortCandidates(shortQuery.data ?? [], floor, 0.25).slice(0, 5);
  }, [shortQuery.data, pickedLeap, longStrike]);

  const applyLeap = (opt: ChainOption) => {
    setLongExpiration(opt.expiration);
    setLongStrike(String(opt.strike));
    setLongDebit(opt.price.toFixed(2));
    setPickedLeap(opt);
    // Clear short pick if it no longer clears the new LEAP strike.
    if (pickedShort && pickedShort.strike <= opt.strike) {
      setPickedShort(null);
      setShortExpiration('');
      setShortStrike('');
      setShortCredit('');
    }
  };
  const applyShort = (opt: ChainOption) => {
    setShortExpiration(opt.expiration);
    setShortStrike(String(opt.strike));
    setShortCredit(opt.price.toFixed(2));
    setPickedShort(opt);
  };

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
      const fetchedAtMs = Math.max(leapQuery.dataUpdatedAt ?? 0, shortQuery.dataUpdatedAt ?? 0);
      const fillDiagnostics = buildPmccFillDiagnostics({
        quantity: contracts,
        longDebit: longDebitNum,
        shortCredit: shortCreditNum,
        longStrike: longStrikeNum,
        longExpiration,
        shortStrike: shortStrikeNum,
        shortExpiration,
        longChain: leapQuery.data,
        shortChain: shortQuery.data,
        chainFetchedAt: fetchedAtMs ? new Date(fetchedAtMs).toISOString() : null,
      });
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
        execution_account_size: capital,
        target_price: profile.longProfitTarget ?? 0.60,
        legs,
        fill_diagnostics: fillDiagnostics,
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
            <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">▌ OPEN_PMCC_POSITION</h3>
            <p className="text-[11px] text-text-tertiary font-mono mt-0.5">
              {profile.subtitle}
            </p>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-phosphor-amber p-1 cursor-pointer" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 pb-5 space-y-4">
          <div>
            <label className="label-mono mb-1 block">▌ TICKER</label>
            <input
              className="input-field"
              value={ticker}
              onChange={e => setTicker(e.target.value.toUpperCase())}
              required
            />
          </div>

          {/* Long LEAP leg */}
          <div className="terminal-panel border-phosphor-green/30 px-3 py-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-mono font-bold text-phosphor-green text-glow-green uppercase tracking-widest">
                ▌ LONG LEAP · δ {profile.longDeltaMin?.toFixed(2)}–{profile.longDeltaMax?.toFixed(2)}
              </p>
              {leapQuery.isFetching && (
                <span className="text-[10px] text-phosphor-dim font-mono uppercase tracking-wider">Loading…</span>
              )}
            </div>
            {/* LEAP suggestions */}
            {leapCandidates.length > 0 && (
              <div className="space-y-1 mb-2.5">
                <div className="flex items-center gap-1 text-[10px] text-text-tertiary font-mono uppercase tracking-wider">
                  <Sparkles size={10} className="text-phosphor-green" /> suggested LEAPs
                </div>
                {leapCandidates.map(opt => {
                  const isPicked = pickedLeap?.strike === opt.strike && pickedLeap?.expiration === opt.expiration;
                  return (
                    <button
                      key={`${opt.expiration}-${opt.strike}`}
                      type="button"
                      onClick={() => applyLeap(opt)}
                      className={`w-full text-left rounded-md px-2 py-1.5 text-[11px] font-mono transition-colors cursor-pointer ${isPicked ? 'bg-phosphor-green/10 border border-phosphor-green/45 text-glow-green' : 'bg-terminal-panel border border-border-default/50 hover:border-phosphor-green/30'}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-text-primary tabular-nums">
                          ${opt.strike} · {formatDate(opt.expiration)} ({opt.dte}d)
                        </span>
                        <span className="font-mono text-phosphor-green tabular-nums">δ{Math.abs(opt.greeks.delta).toFixed(2)} · ${opt.price.toFixed(2)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {leapQuery.isError && (
              <p className="text-[10px] text-phosphor-amber font-mono mb-2">Couldn't load LEAP chain — enter manually.</p>
            )}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label-mono mb-1 block">
                  EXPIRATION
                  {longDte != null && (
                    <span className={`ml-1 text-[9px] font-mono px-1 py-0.5 rounded ${longDteInRange ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/30' : 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/30'}`}>
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
                <label className="label-mono mb-1 block">STRIKE</label>
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
                <label className="label-mono mb-1 block">DEBIT PAID</label>
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
          <div className="terminal-panel terminal-panel-amber px-3 py-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-mono font-bold text-phosphor-amber text-glow-amber uppercase tracking-widest">
                ▌ SHORT MONTHLY · δ {profile.shortDeltaMin?.toFixed(2)}–{profile.shortDeltaMax?.toFixed(2)}
              </p>
              {shortQuery.isFetching && (
                <span className="text-[10px] text-phosphor-dim font-mono uppercase tracking-wider">Loading…</span>
              )}
            </div>
            {/* Short suggestions — shown once a LEAP strike exists to filter by. */}
            {shortCandidates.length > 0 && (
              <div className="space-y-1 mb-2.5">
                <div className="flex items-center gap-1 text-[10px] text-text-tertiary font-mono uppercase tracking-wider">
                  <Sparkles size={10} className="text-phosphor-amber" /> suggested shorts (strike &gt; LEAP ${pickedLeap?.strike ?? longStrikeNum})
                </div>
                {shortCandidates.map(opt => {
                  const isPicked = pickedShort?.strike === opt.strike && pickedShort?.expiration === opt.expiration;
                  return (
                    <button
                      key={`${opt.expiration}-${opt.strike}`}
                      type="button"
                      onClick={() => applyShort(opt)}
                      className={`w-full text-left rounded-md px-2 py-1.5 text-[11px] font-mono transition-colors cursor-pointer ${isPicked ? 'bg-phosphor-amber/10 border border-phosphor-amber/45 text-glow-amber' : 'bg-terminal-panel border border-border-default/50 hover:border-phosphor-amber/30'}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-text-primary tabular-nums">
                          ${opt.strike} · {formatDate(opt.expiration)} ({opt.dte}d)
                        </span>
                        <span className="font-mono text-phosphor-amber tabular-nums">δ{Math.abs(opt.greeks.delta).toFixed(2)} · ${opt.price.toFixed(2)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {shortQuery.isError && (
              <p className="text-[10px] text-phosphor-amber font-mono mb-2">Couldn't load short chain — enter manually.</p>
            )}
            {!pickedLeap && isNaN(longStrikeNum) && !shortQuery.isFetching && (
              <p className="text-[10px] text-text-tertiary font-mono mb-2">Pick a LEAP above to filter short candidates by strike.</p>
            )}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label-mono mb-1 block">
                  EXPIRATION
                  {shortDte != null && (
                    <span className={`ml-1 text-[9px] font-mono px-1 py-0.5 rounded ${shortDteInRange ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/30' : 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/30'}`}>
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
                <label className="label-mono mb-1 block">STRIKE</label>
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
                <label className="label-mono mb-1 block">CREDIT RECEIVED</label>
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
            <label className="label-mono mb-1 block">
              ▌ CONTRACTS <span className="text-text-tertiary/70 normal-case font-normal">(suggested {suggestedContracts})</span>
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
            <div className="terminal-panel px-3 py-2.5 text-xs font-mono space-y-1">
              <div className="flex justify-between">
                <span className="label-mono">NET DEBIT / CONTRACT</span>
                <span className="text-text-primary tabular-nums">${netDebit.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="label-mono">MAX LOSS (LEAP COST)</span>
                <span className="text-phosphor-red text-glow-red tabular-nums">${(maxLossPerContract * contracts).toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="label-mono">LONG PT (+{((profile.longProfitTarget ?? 0.60) * 100).toFixed(0)}%)</span>
                <span className="text-phosphor-green text-glow-green tabular-nums">
                  +${(maxLossPerContract * (profile.longProfitTarget ?? 0.60) * contracts).toFixed(0)}
                </span>
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
              {submitting ? '▌ OPENING...' : '▌ OPEN PMCC'}
            </button>
          </div>

          <p className="text-[10px] text-text-tertiary font-mono">
            ▌ Entered as paper by default. Short leg rolls tracked as roll transactions.
          </p>
        </form>
      </motion.div>
    </motion.div>
  );
};
