/**
 * PMCCRollShortModal — focused roll workflow for the PMCC short leg.
 *
 * Closes the current active short and opens a new one in a single atomic
 * mutation. Long LEAP is untouched. Records both legs of the cycle on the
 * position and inserts paired transactions for audit.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useRollPMCCShort } from '../hooks/usePositionMutations';
import { useChainCandidates } from '../hooks/useChainCandidates';
import { useOptionQuote } from '../hooks/useOptionQuote';
import { splitPMCCLegs } from '../lib/pmccCycles';
import { STRATEGY_PROFILES } from '../lib/strategyProfiles';
import { formatDate, formatDateWithYear } from '../lib/utils';
import {
  buildPMCCRollShortCandidates,
  type ChainOption,
} from '../lib/chainCandidates';
import type { Position } from '../lib/types';

interface Props {
  position: Position;
  isOpen: boolean;
  onClose: () => void;
}

export const PMCCRollShortModal: React.FC<Props> = ({ position, isOpen, onClose }) => {
  const rollShort = useRollPMCCShort();
  const profile = STRATEGY_PROFILES.pmcc;
  const { longLeg, activeShort } = splitPMCCLegs(position);

  const [closeCost, setCloseCost] = useState('');
  const [newStrike, setNewStrike] = useState('');
  const [newExpiration, setNewExpiration] = useState('');
  const [newCredit, setNewCredit] = useState('');
  const [pickedShort, setPickedShort] = useState<ChainOption | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const didAutoPickShort = useRef(false);
  const didAutoPriceClose = useRef(false);

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const shortExpired = Boolean(activeShort?.expiration && activeShort.expiration < today);

  const shortQuery = useChainCandidates(isOpen && position.ticker ? {
    ticker: position.ticker,
    direction: 'call',
    strategy: 'long',
    dteMin: profile.shortDteMin ?? 30,
    dteMax: profile.shortDteMax ?? 45,
    minDelta: profile.shortDeltaMin ?? 0.20,
    maxDelta: profile.shortDeltaMax ?? 0.30,
    strikeRange: 0.25,
    minVolume: 0,
    maxSpreadPct: 0.30,
  } : null);

  const currentShortQuote = useOptionQuote(
    isOpen && activeShort && !shortExpired
      ? {
          ticker: position.ticker,
          expiration: activeShort.expiration,
          strike: activeShort.strike,
          type: activeShort.type,
        }
      : null,
  );

  const rollCandidates = useMemo(() => {
    if (!activeShort) return [];
    return buildPMCCRollShortCandidates(shortQuery.data ?? [], {
      leapStrike: longLeg?.strike ?? 0,
      currentShortStrike: activeShort.strike,
      currentShortExpiration: activeShort.expiration,
      targetDelta: 0.25,
    }).slice(0, 5);
  }, [activeShort, longLeg, shortQuery.data]);

  const applyShort = (opt: ChainOption) => {
    setNewExpiration(opt.expiration);
    setNewStrike(String(opt.strike));
    const sellPrice = opt.liquidity.bid > 0 ? opt.liquidity.bid : opt.price;
    setNewCredit(sellPrice.toFixed(2));
    setPickedShort(opt);
  };

  useEffect(() => {
    if (!isOpen) {
      didAutoPickShort.current = false;
      setNewExpiration('');
      setNewStrike('');
      setNewCredit('');
      setPickedShort(null);
      return;
    }
    const recommended = rollCandidates[0];
    if (!recommended || didAutoPickShort.current) return;
    if (newExpiration || newStrike || newCredit) {
      didAutoPickShort.current = true;
      return;
    }
    const sellPrice = recommended.liquidity.bid > 0
      ? recommended.liquidity.bid
      : recommended.price;
    setNewExpiration(recommended.expiration);
    setNewStrike(String(recommended.strike));
    setNewCredit(sellPrice.toFixed(2));
    setPickedShort(recommended);
    didAutoPickShort.current = true;
  }, [isOpen, newCredit, newExpiration, newStrike, rollCandidates]);

  useEffect(() => {
    if (!isOpen) {
      didAutoPriceClose.current = false;
      setCloseCost('');
      return;
    }
    if (didAutoPriceClose.current) return;
    if (closeCost) {
      didAutoPriceClose.current = true;
      return;
    }

    if (shortExpired && position.is_paper) {
      setCloseCost('0.00');
      didAutoPriceClose.current = true;
      return;
    }

    const buybackPrice = currentShortQuote.data?.ask ?? currentShortQuote.data?.price;
    if (buybackPrice != null && Number.isFinite(buybackPrice)) {
      setCloseCost(buybackPrice.toFixed(2));
      didAutoPriceClose.current = true;
    }
  }, [
    closeCost,
    currentShortQuote.data,
    isOpen,
    position.is_paper,
    shortExpired,
  ]);

  if (!isOpen) return null;

  if (!activeShort) {
    return (
      <div className="fixed inset-0 modal-overlay flex items-center justify-center p-4 z-[100]" role="dialog" aria-modal="true">
        <div className="terminal-panel p-6 w-full max-w-md">
          <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-amber mb-3">▌ NO_ACTIVE_SHORT</h3>
          <p className="text-sm text-text-secondary font-mono mb-4">This PMCC has no active short leg to roll. Use Manage to add a new short manually.</p>
          <button onClick={onClose} className="btn-terminal w-full">Close</button>
        </div>
      </div>
    );
  }

  const closeCostNum = parseFloat(closeCost);
  const newCreditNum = parseFloat(newCredit);
  const newStrikeNum = parseFloat(newStrike);
  const valid = Number.isFinite(closeCostNum) && closeCostNum >= 0
    && Number.isFinite(newCreditNum) && newCreditNum > 0
    && Number.isFinite(newStrikeNum) && newStrikeNum > 0
    && newExpiration.length === 10;

  const cycleRealizedPerContract = activeShort.openedCredit != null && Number.isFinite(closeCostNum)
    ? (activeShort.openedCredit - closeCostNum) * 100
    : null;
  const netCredit = Number.isFinite(closeCostNum) && Number.isFinite(newCreditNum)
    ? newCreditNum - closeCostNum
    : null;

  const handleConfirm = async () => {
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    try {
      await rollShort.mutateAsync({
        position,
        closeCost: closeCostNum,
        newStrike: newStrikeNum,
        newExpiration,
        newCredit: newCreditNum,
        cycleQty: activeShort.cycleQty,
      });
      onClose();
      setCloseCost('');
      setNewStrike('');
      setNewExpiration('');
      setNewCredit('');
      setPickedShort(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 modal-overlay flex items-center justify-center p-4 z-[100]" role="dialog" aria-modal="true" aria-label="Roll PMCC short leg">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="terminal-panel p-6 w-full max-w-2xl fade-in max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">▌ ROLL_PMCC_SHORT</h3>
          <button onClick={onClose} className="text-text-tertiary hover:text-phosphor-red" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <p className="text-xs font-mono text-text-secondary mb-4 leading-relaxed">
          Long LEAP stays in place. Closes the current short call and opens a new one. Cycle realized P&L is recorded against the position.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Close Existing Short */}
          <div className="terminal-panel terminal-panel-red p-4">
            <h4 className="text-xs font-mono font-bold text-phosphor-red text-glow-red mb-2 uppercase tracking-widest">▌ CLOSE_CURRENT_SHORT</h4>
            <div className="text-xs font-mono text-text-secondary mb-3 tabular-nums">
              K={activeShort.strike} {activeShort.type} · {formatDateWithYear(activeShort.expiration)}
              {activeShort.openedCredit != null && (
                <span className="ml-2 text-phosphor-green">credit ${activeShort.openedCredit.toFixed(2)}</span>
              )}
            </div>
            <label className="label-mono mb-1 block">CLOSE COST (per share, debit)</label>
            <input
              aria-label="Close cost"
              type="number"
              step="0.01"
              min="0"
              value={closeCost}
              onChange={e => setCloseCost(e.target.value)}
              className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
              placeholder="e.g. 1.20"
            />
            {currentShortQuote.isFetching && (
              <p className="mt-1.5 text-[10px] text-phosphor-dim font-mono">Loading live buyback ask…</p>
            )}
            {!shortExpired && currentShortQuote.data && (
              <p className="mt-1.5 text-[10px] text-text-tertiary font-mono">Live ask auto-filled. Replace it with your broker fill before confirming.</p>
            )}
            {!shortExpired && currentShortQuote.isError && (
              <p className="mt-1.5 text-[10px] text-phosphor-amber font-mono">Live buyback quote unavailable — enter your broker fill.</p>
            )}
            {shortExpired && position.is_paper && (
              <p className="mt-1.5 text-[10px] text-phosphor-amber font-mono">Expired paper short defaults to $0.00. Confirm it expired worthless before rolling.</p>
            )}
            {shortExpired && !position.is_paper && (
              <p className="mt-1.5 text-[10px] text-phosphor-amber font-mono">Expired live short cannot be quoted. Enter the broker settlement or assignment cost.</p>
            )}
            {cycleRealizedPerContract != null && (
              <div className="mt-2 text-[11px] font-mono text-text-tertiary">
                Cycle realized: <span className={cycleRealizedPerContract >= 0 ? 'text-phosphor-green' : 'text-phosphor-red'}>
                  {cycleRealizedPerContract >= 0 ? '+' : ''}${cycleRealizedPerContract.toFixed(2)}/contract
                </span>
              </div>
            )}
          </div>

          {/* Open New Short */}
          <div className="terminal-panel border-phosphor-green/45 p-4">
            <h4 className="text-xs font-mono font-bold text-phosphor-green text-glow-green mb-2 uppercase tracking-widest">▌ OPEN_NEW_SHORT</h4>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] text-text-tertiary font-mono uppercase tracking-wider">
                δ {profile.shortDeltaMin?.toFixed(2)}–{profile.shortDeltaMax?.toFixed(2)} · {profile.shortDteMin}–{profile.shortDteMax}d
              </p>
              {shortQuery.isFetching && (
                <span className="text-[10px] text-phosphor-dim font-mono uppercase tracking-wider">Loading...</span>
              )}
            </div>
            {rollCandidates.length > 0 && (
              <div className="space-y-1 mb-3">
                <div className="flex items-center gap-1 text-[10px] text-text-tertiary font-mono uppercase tracking-wider">
                  <Sparkles size={10} className="text-phosphor-green" /> recommended short auto-selected
                </div>
                {rollCandidates[0].strike <= activeShort.strike && (
                  <p className="text-[10px] text-phosphor-amber font-mono">
                    No higher strike was returned in-band, so this is the best later-dated reset above the LEAP strike.
                  </p>
                )}
                {rollCandidates.map(opt => {
                  const isPicked = pickedShort?.strike === opt.strike && pickedShort?.expiration === opt.expiration;
                  return (
                    <button
                      key={`${opt.expiration}-${opt.strike}`}
                      type="button"
                      onClick={() => applyShort(opt)}
                      className={`w-full text-left rounded-md px-2 py-1.5 text-[11px] font-mono transition-colors cursor-pointer ${isPicked ? 'bg-phosphor-green/10 border border-phosphor-green/45 text-glow-green' : 'bg-terminal-panel border border-border-default/50 hover:border-phosphor-green/30'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-text-primary tabular-nums">
                          ${opt.strike} · {formatDate(opt.expiration)} ({opt.dte}d)
                        </span>
                        <span className="font-mono text-phosphor-green tabular-nums">
                          δ{Math.abs(opt.greeks.delta).toFixed(2)} · bid ${(opt.liquidity.bid > 0 ? opt.liquidity.bid : opt.price).toFixed(2)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {shortQuery.isError && (
              <p className="text-[10px] text-phosphor-amber font-mono mb-2">Couldn't load roll candidates — enter manually.</p>
            )}
            {!shortQuery.isFetching && !shortQuery.isError && rollCandidates.length === 0 && (
              <p className="text-[10px] text-text-tertiary font-mono mb-2">No strategy-band roll candidates found — enter manually.</p>
            )}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label className="label-mono mb-1 block">EXPIRATION</label>
                <input
                  aria-label="New expiration"
                  type="date"
                  value={newExpiration}
                  onChange={e => {
                    setNewExpiration(e.target.value);
                    setPickedShort(null);
                  }}
                  className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white text-xs"
                />
              </div>
              <div>
                <label className="label-mono mb-1 block">STRIKE</label>
                <input
                  aria-label="New strike"
                  type="number"
                  step="0.5"
                  value={newStrike}
                  onChange={e => {
                    setNewStrike(e.target.value);
                    setPickedShort(null);
                  }}
                  className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white text-xs"
                  placeholder="K"
                />
              </div>
            </div>
            <label className="label-mono mb-1 block">CREDIT (per share)</label>
            <input
              aria-label="New credit"
              type="number"
              step="0.01"
              min="0"
              value={newCredit}
              onChange={e => {
                setNewCredit(e.target.value);
                setPickedShort(null);
              }}
              className="w-full px-3 py-2 rounded-md font-mono bg-terminal-black border border-border-default text-white"
              placeholder="e.g. 4.20"
            />
          </div>
        </div>

        {netCredit != null && (
          <div className="mt-4 terminal-panel p-3 text-center text-xs font-mono uppercase tracking-wider">
            <span className="text-text-tertiary">▌ NET CREDIT THIS ROLL: </span>
            <span className={`font-mono font-bold ${netCredit >= 0 ? 'text-phosphor-green text-glow-green' : 'text-phosphor-red text-glow-red'}`}>
              {netCredit >= 0 ? '+' : ''}${netCredit.toFixed(2)}/share ({netCredit >= 0 ? '+' : ''}${(netCredit * 100).toFixed(0)}/contract)
            </span>
          </div>
        )}

        {error && (
          <div className="mt-3 text-xs font-mono text-phosphor-red text-glow-red">▌ {error}</div>
        )}

        <div className="flex gap-3 mt-5">
          <button onClick={onClose} className="btn-terminal-danger flex-1" disabled={submitting}>CANCEL</button>
          <button
            onClick={handleConfirm}
            disabled={!valid || submitting}
            className="btn-terminal flex-1"
          >
            {submitting ? '▌ ROLLING...' : '▌ CONFIRM ROLL'}
          </button>
        </div>
      </motion.div>
    </div>
  );
};
