import React, { useState, useRef, useCallback, useEffect } from 'react';
import { RefreshCw, ChevronDown } from 'lucide-react';
import type { DirectAddItem, PositionLeg } from '../lib/types';
import type { StrategyProfile, StrategyType } from '../lib/strategyProfiles';

interface Props {
    onAddDirect: (item: DirectAddItem) => Promise<void>;
    onClose: () => void;
    profile: StrategyProfile;
    activeStrategy: StrategyType;
}

export const QuickAddPositionForm: React.FC<Props> = ({ onAddDirect, onClose, profile, activeStrategy }) => {
    const [positionType, setPositionType] = useState<'single' | 'credit' | 'debit'>('credit');
    const [formOwner, setFormOwner] = useState<'Yuchen' | 'Annie'>('Yuchen');
    const [submitting, setSubmitting] = useState(false);
    const [scoreFetching, setScoreFetching] = useState(false);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const scoreFetchRef = useRef(0);
    const isDTE5 = activeStrategy === 'dte5';
    const [form, setForm] = useState({
        ticker: isDTE5 ? 'QQQ' : '', strike: '', strike2: '', type: 'Put', expiration: '',
        setup: isDTE5 ? 'DTE5 Bull Put' : 'Directional', strategy: '', entry_score: '', tech_score: '',
        stop_reason: '', quantity: '1', entry_price: '', direction: 'BULL' as 'BULL' | 'BEAR',
        iv_regime_entry: '', market_state: '',
    });

    const fetchEntryScore = useCallback(async (ticker: string, strike: string, expiration: string, optType: string) => {
        if (!ticker || !strike || !expiration || !optType) return;
        const fetchId = ++scoreFetchRef.current;
        setScoreFetching(true);
        try {
            const strikeNum = parseFloat(strike);
            const params = new URLSearchParams({
                ticker, strategy: 'long', dteMin: '0', dteMax: '365',
                strikeRange: '1.0', minVolume: '0', maxSpreadPct: '1.0',
                minDelta: '0', maxDelta: '1',
                direction: optType === 'Call' ? 'bullish' : 'bearish',
            });
            const res = await fetch(`/api/scan-options?${params}`);
            if (fetchId !== scoreFetchRef.current) return;
            if (!res.ok) return;
            const data = await res.json();
            if (fetchId !== scoreFetchRef.current) return;
            const match = data.results?.find((r: any) =>
                Math.abs(r.strike - strikeNum) < 0.01 &&
                r.expiration === expiration &&
                r.type?.toLowerCase() === optType.toLowerCase()
            );
            if (match?.score != null) {
                setForm(prev => ({ ...prev, entry_score: String(Math.round(match.score)) }));
            }
        } catch {
            // silent
        } finally {
            if (fetchId === scoreFetchRef.current) setScoreFetching(false);
        }
    }, []);

    useEffect(() => {
        if (form.ticker && form.strike && form.expiration && form.type) {
            const timer = setTimeout(() => {
                fetchEntryScore(form.ticker, form.strike, form.expiration, form.type);
            }, 600);
            return () => clearTimeout(timer);
        }
    }, [form.ticker, form.strike, form.expiration, form.type, fetchEntryScore]);

    const dte = form.expiration
        ? Math.round((new Date(form.expiration + 'T00:00:00').getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null;
    const dteInRange = dte != null && dte >= profile.dteMin && dte <= profile.dteMax;

    const spreadWidth = (positionType !== 'single' && form.strike && form.strike2)
        ? Math.abs(parseFloat(form.strike) - parseFloat(form.strike2))
        : null;
    const maxRiskPerContract = (positionType === 'credit' && spreadWidth != null && form.entry_price)
        ? (spreadWidth - parseFloat(form.entry_price)) * 100
        : (positionType === 'debit' && form.entry_price)
            ? parseFloat(form.entry_price) * 100
            : null;

    const deriveStrategy = (posType: string, optType: string): string => {
        if (posType === 'single') return `Long ${optType}`;
        if (posType === 'credit') return `Credit ${optType} Spread`;
        return `Debit ${optType} Spread`;
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);

        const strategy = deriveStrategy(positionType, form.type);
        const techScoreNum = form.tech_score ? Number(form.tech_score) : undefined;

        if (positionType === 'single') {
            await onAddDirect({
                ticker: form.ticker, strike: parseFloat(form.strike), type: form.type,
                expiration: form.expiration, setup: form.setup, strategy,
                entry_score: parseInt(form.entry_score), tech_score: techScoreNum,
                stop_reason: form.stop_reason, quantity: parseInt(form.quantity),
                entry_price: parseFloat(form.entry_price), direction: form.direction,
                iv_regime_entry: form.iv_regime_entry || undefined,
                market_state: form.market_state || undefined,
                owner: formOwner, strategy_type: activeStrategy,
                is_paper: isDTE5 ? true : undefined,
            });
        } else {
            const shortStrike = parseFloat(form.strike);
            const longStrike = parseFloat(form.strike2);
            const isCredit = positionType === 'credit';
            const typeName = isCredit ? `Credit ${form.type} Spread` : `Debit ${form.type} Spread`;
            const anchorStrike = isCredit ? shortStrike : longStrike;
            const legs: PositionLeg[] = [
                { strike: shortStrike, type: form.type, side: 'short', expiration: form.expiration },
                { strike: longStrike, type: form.type, side: 'long', expiration: form.expiration },
            ];
            await onAddDirect({
                ticker: form.ticker, strike: anchorStrike, type: typeName,
                expiration: form.expiration, setup: form.setup, strategy,
                entry_score: parseInt(form.entry_score), tech_score: techScoreNum,
                stop_reason: form.stop_reason, quantity: parseInt(form.quantity),
                entry_price: parseFloat(form.entry_price), legs,
                direction: form.direction, iv_regime_entry: form.iv_regime_entry || undefined,
                market_state: form.market_state || undefined,
                owner: formOwner, spread_width: spreadWidth ?? undefined,
                max_risk_entry: maxRiskPerContract != null && maxRiskPerContract > 0 ? maxRiskPerContract : undefined,
                trade_profile: isCredit ? 'credit_spread' : 'debit_spread',
                strategy_type: activeStrategy,
                is_paper: isDTE5 ? true : undefined,
            });
        }

        setSubmitting(false);
        setForm({ ticker: isDTE5 ? 'QQQ' : '', strike: '', strike2: '', type: 'Put', expiration: '', setup: isDTE5 ? 'DTE5 Bull Put' : 'Directional', strategy: '', entry_score: '', tech_score: '', stop_reason: '', quantity: '1', entry_price: '', direction: 'BULL', iv_regime_entry: '', market_state: '' });
        setPositionType('credit');
        onClose();
    };

    return (
        <div className="terminal-panel p-8 animate-in fade-in slide-in-from-top-4 relative overflow-hidden group">
            <div className={`absolute top-0 left-0 w-1 h-full ${isDTE5 ? 'bg-phosphor-amber' : 'bg-phosphor-green'}`} />
            {isDTE5 && (
                <div className="mb-4 px-3 py-2 rounded-md bg-phosphor-amber/10 border border-phosphor-amber/30 border-dashed">
                    <p className="text-[11px] font-mono uppercase tracking-wider text-phosphor-amber text-glow-amber">▌ PAPER · DTE5 Bull Put Spread (QQQ, hold-to-expiry)</p>
                </div>
            )}
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h3 className="text-sm sm:text-base font-mono font-bold uppercase tracking-widest text-phosphor-green text-glow-green">▌ {isDTE5 ? 'ADD_DTE5_PAPER_TRADE' : 'QUICK_ADD_POSITION'}</h3>
                    <p className="text-sm text-text-tertiary">{isDTE5 ? 'QQQ bull put spread \u2022 Delta 30/20 \u2022 Hold to expiry' : 'Enter the details of your new option position'}</p>
                </div>
                <button onClick={onClose} className="p-2 hover:bg-phosphor-amber/10 rounded-md transition-colors text-text-tertiary hover:text-phosphor-amber cursor-pointer">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-8">
                {/* Position Type Toggle */}
                <div className="flex items-center gap-4">
                    <div className="grid grid-cols-3 gap-2 flex-1">
                        {([['single', 'Single Leg'], ['credit', 'Credit Spread'], ['debit', 'Debit Spread']] as const).map(([value, label]) => (
                            <button key={value} type="button" onClick={() => setPositionType(value)}
                                className={`px-3 py-3 rounded-md text-[11px] font-mono uppercase tracking-wider transition-all cursor-pointer ${positionType === value
                                    ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40'
                                    : 'bg-terminal-panel text-text-tertiary border border-border-default/50 hover:text-phosphor-dim hover:border-phosphor-green/20'
                                }`}
                            >{label}</button>
                        ))}
                    </div>
                    <div className="flex gap-1.5">
                        {(['Yuchen', 'Annie'] as const).map(name => (
                            <button key={name} type="button" onClick={() => setFormOwner(name)}
                                className={`px-3 py-2 rounded-md text-[11px] font-mono uppercase tracking-wider transition-all cursor-pointer ${formOwner === name
                                    ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40'
                                    : 'bg-terminal-panel text-text-tertiary border border-border-default/50 hover:text-phosphor-dim hover:border-phosphor-green/20'
                                }`}
                            >▌ {name.toUpperCase()}</button>
                        ))}
                    </div>
                </div>

                {/* Row 1: Basic Info */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6">
                    <div className="space-y-1.5">
                        <label htmlFor="ticker">Symbol</label>
                        <input id="ticker" placeholder="e.g. SPY" className="input-field"
                            value={form.ticker} onChange={e => setForm({ ...form, ticker: e.target.value.toUpperCase() })} required />
                    </div>
                    {positionType === 'single' ? (
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <label htmlFor="strike">Strike</label>
                                <input id="strike" type="number" inputMode="decimal" placeholder="0.00" className="input-field"
                                    value={form.strike} onChange={e => setForm({ ...form, strike: e.target.value })} required />
                            </div>
                            <div className="space-y-1.5">
                                <label htmlFor="type">Type</label>
                                <select id="type" className="input-field" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                                    <option value="Call">Call</option>
                                    <option value="Put">Put</option>
                                </select>
                            </div>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:col-span-1 lg:col-span-2">
                            <div className="space-y-1.5">
                                <label htmlFor="strike">Short Strike</label>
                                <input id="strike" type="number" inputMode="decimal" placeholder="0.00" className="input-field"
                                    value={form.strike} onChange={e => setForm({ ...form, strike: e.target.value })} required />
                            </div>
                            <div className="space-y-1.5">
                                <label htmlFor="strike2">Long Strike</label>
                                <input id="strike2" type="number" inputMode="decimal" placeholder="0.00" className="input-field"
                                    value={form.strike2} onChange={e => setForm({ ...form, strike2: e.target.value })} required />
                            </div>
                            <div className="space-y-1.5 col-span-2 md:col-span-1">
                                <label htmlFor="type">Type</label>
                                <select id="type" className="input-field" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                                    <option value="Call">Call</option>
                                    <option value="Put">Put</option>
                                </select>
                            </div>
                        </div>
                    )}
                    <div className="space-y-1.5">
                        <label htmlFor="expiration">
                            Expiration
                            {dte != null && (
                                <span className={`ml-2 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded ${dteInRange ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/30' : 'bg-phosphor-amber/10 text-phosphor-amber text-glow-amber border border-phosphor-amber/30'}`}>
                                    {dte}d{!dteInRange && ' ⚠'}
                                </span>
                            )}
                        </label>
                        <input id="expiration" type="date" className="input-field"
                            value={form.expiration} onChange={e => setForm({ ...form, expiration: e.target.value })} required />
                    </div>
                </div>

                {/* Spread Info Bar */}
                {positionType !== 'single' && (spreadWidth != null || maxRiskPerContract != null) && (
                    <div className="flex items-center gap-4 text-xs font-mono px-3 py-2 terminal-panel">
                        {spreadWidth != null && (
                            <span className="text-text-secondary uppercase tracking-wider">
                                <span className="label-mono">WIDTH:</span> <span className={`font-bold tabular-nums ${spreadWidth === profile.defaultWidth ? 'text-phosphor-green text-glow-green' : spreadWidth > 0 ? 'text-text-primary' : ''}`}>${spreadWidth}</span>
                                {spreadWidth !== profile.defaultWidth && spreadWidth > 0 && positionType === 'credit' && (
                                    <span className="text-phosphor-amber ml-1">(${profile.defaultWidth} recommended)</span>
                                )}
                            </span>
                        )}
                        {maxRiskPerContract != null && maxRiskPerContract > 0 && (
                            <span className="text-text-secondary uppercase tracking-wider">
                                <span className="label-mono">MAX RISK:</span> <span className="text-text-primary font-bold tabular-nums">${maxRiskPerContract.toFixed(0)}</span>/CT
                            </span>
                        )}
                    </div>
                )}

                {/* Row 2: Execution */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6">
                    <div className="space-y-1.5">
                        <label className="label-mono">Direction</label>
                        <div className="flex gap-2">
                            {(['BULL', 'BEAR'] as const).map(d => (
                                <button key={d} type="button" onClick={() => setForm({ ...form, direction: d })}
                                    className={`flex-1 py-2.5 rounded-md text-[11px] font-mono uppercase tracking-wider transition-all cursor-pointer ${form.direction === d
                                        ? d === 'BULL'
                                            ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40'
                                            : 'bg-phosphor-red/10 text-phosphor-red text-glow-red border border-phosphor-red/40'
                                        : 'bg-terminal-panel text-text-tertiary border border-border-default/50 hover:text-phosphor-dim hover:border-phosphor-green/20'
                                    }`}
                                >{d === 'BULL' ? '▲ BULL' : '▼ BEAR'}</button>
                            ))}
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor="quantity">Quantity</label>
                        <input id="quantity" type="number" placeholder="1" className="input-field"
                            value={form.quantity} onChange={e => setForm({ ...form, quantity: e.target.value })} required />
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor="price">{positionType === 'credit' ? 'Net Credit' : positionType === 'debit' ? 'Net Debit' : 'Entry Price'}</label>
                        <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary select-none">$</span>
                            <input id="price" type="number" step="0.01" placeholder="0.00" className="input-field pl-8"
                                value={form.entry_price} onChange={e => setForm({ ...form, entry_price: e.target.value })} required />
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <label htmlFor="score">Score {scoreFetching && <span className="text-xs text-text-tertiary animate-pulse ml-1">fetching…</span>}</label>
                        <input id="score" type="number" placeholder={scoreFetching ? '…' : 'auto'} className="input-field"
                            value={form.entry_score} onChange={e => setForm({ ...form, entry_score: e.target.value })} />
                    </div>
                </div>

                {/* Collapsible: More Details */}
                <div>
                    <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}
                        className="text-xs font-medium text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-1.5">
                        <ChevronDown size={14} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                        More details (tech score, trade notes, market state, IV regime)
                    </button>
                    {showAdvanced && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6 mt-4 pt-4 border-t border-border-default/30">
                            <div className="space-y-1.5">
                                <label htmlFor="tech_score">Tech Score</label>
                                <input id="tech_score" type="number" min="0" max="100" placeholder="0-100" className="input-field"
                                    value={form.tech_score} onChange={e => setForm({ ...form, tech_score: e.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                                <label htmlFor="stop_reason">Trade Notes</label>
                                <input id="stop_reason" placeholder="Optional" className="input-field"
                                    value={form.stop_reason} onChange={e => setForm({ ...form, stop_reason: e.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                                <label className="label-mono">Market State</label>
                                <div className="grid grid-cols-4 gap-1">
                                    {[{ label: 'TREND', value: 'TRENDING' }, { label: 'EXPL', value: 'EXPLOSIVE' },
                                      { label: 'RANGE', value: 'RANGING' }, { label: 'REV', value: 'REVERTING' }].map(opt => (
                                        <button key={opt.value} type="button"
                                            onClick={() => setForm({ ...form, market_state: form.market_state === opt.value ? '' : opt.value })}
                                            className={`py-2 rounded-md text-[10px] font-mono uppercase tracking-wider transition-all cursor-pointer ${form.market_state === opt.value
                                                ? 'bg-phosphor-green/10 text-phosphor-green text-glow-green border border-phosphor-green/40'
                                                : 'bg-terminal-panel text-text-tertiary border border-border-default/50 hover:text-phosphor-dim hover:border-phosphor-green/20'
                                            }`}
                                        >{opt.label}</button>
                                    ))}
                                </div>
                            </div>
                            <div className="space-y-1.5">
                                <label htmlFor="iv_regime" className="label-mono">IV Regime</label>
                                <select id="iv_regime" className="input-field"
                                    value={form.iv_regime_entry} onChange={e => setForm({ ...form, iv_regime_entry: e.target.value })}>
                                    <option value="">— Unknown —</option>
                                    <option value="CREDIT">CREDIT (Hi HV)</option>
                                    <option value="DEBIT">DEBIT (Lo HV)</option>
                                    <option value="NEUTRAL">NEUTRAL</option>
                                </select>
                            </div>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex justify-end items-center gap-4 pt-4 border-t border-phosphor-green/15">
                    <button type="button" onClick={onClose}
                        className="btn-terminal-danger">
                        CANCEL
                    </button>
                    <button type="submit" disabled={submitting}
                        className="btn-terminal flex items-center gap-2">
                        {submitting ? (
                            <><RefreshCw size={14} className="animate-spin" /><span>ADDING...</span></>
                        ) : (
                            <><span className="text-base leading-none">+</span><span>ADD POSITION</span></>
                        )}
                    </button>
                </div>
            </form>
        </div>
    );
};
