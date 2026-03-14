import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TrendingUp, TrendingDown, Activity, Info, ChevronDown, AlertCircle, Search, Bookmark, Settings2, RefreshCw, ShoppingCart } from 'lucide-react';
import { Tooltip } from '../components/Tooltip';
import { DataFooter } from '../components/DataFooter';
import { ScoreFactorsView } from '../components/ScoreFactorsView';
import { PortfolioSettingsForm } from '../components/PortfolioSettingsForm';
import { useAppSettings } from '../context/AppSettingsContext';
import { getProfile } from '../lib/strategyProfiles';
import { getSuggestedContracts } from '../lib/riskSizing';
import { classifyTradeProfile } from '../lib/oss-core';
import { formatCurrency } from '../lib/utils';
import { useAddToWatchlist, useAddDirect } from '../hooks/usePositionMutations';
import { PayoffDiagram } from '../components/strategy/PayoffDiagram';
import type {
    SpreadRecommendation,
    SingleLegRecommendation,
    Recommendation,
    StrategyResult,
    WatchlistItem,
    DirectAddItem,
    PositionLeg,
    UnifiedCandidateType,
    StrategyCategory,
} from '../lib/types';

interface OptionSelectorProps {
    onAddToWatchlist?: (item: WatchlistItem) => Promise<void>;
    onAddDirect?: (item: DirectAddItem) => Promise<void>;
}

// localStorage key for persisting selector state
const LS_KEY = 'optionSelector:state';

function loadPersistedState() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return {};
}

export const OptionSelector: React.FC<OptionSelectorProps> = ({ onAddToWatchlist: onAddToWatchlistProp, onAddDirect: onAddDirectProp }) => {
    const addToWatchlistMut = useAddToWatchlist();
    const addDirectMut = useAddDirect();
    const onAddToWatchlist = onAddToWatchlistProp ?? (async (item: WatchlistItem) => { addToWatchlistMut.mutate(item); });
    const onAddDirect = onAddDirectProp ?? (async (item: DirectAddItem) => { addDirectMut.mutate(item); });
    const { settings, stopOutFraction, activeStrategy, setActiveStrategy } = useAppSettings();
    const profile = getProfile(activeStrategy);
    const { accountSize: portfolioTotal, riskPct } = settings.portfolio;
    const tickerRef = useRef<HTMLInputElement>(null);
    const persisted = useRef(loadPersistedState());

    const [ticker, setTicker] = useState('SPY');
    const [direction, setDirection] = useState<'BULL' | 'BEAR'>(persisted.current.direction || 'BULL');
    const [techScoreTier, setTechScoreTier] = useState<{ label: string; value: number; range: string; color: string } | null>(null);
    const [targetDte, setTargetDte] = useState(persisted.current.targetDte || profile.dtePeak);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState<StrategyResult | null>(null);
    const [expandedCard, setExpandedCard] = useState<number | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    const [spreadWidth, setSpreadWidth] = useState(persisted.current.spreadWidth || profile.defaultWidth);
    // Open Position inline form state
    const [openPosIdx, setOpenPosIdx] = useState<number | null>(null);
    const [openPosQty, setOpenPosQty] = useState('');
    const [openPosPrice, setOpenPosPrice] = useState('');
    const [openPosOwner, setOpenPosOwner] = useState<'Yuchen' | 'Annie'>('Yuchen');
    const [openPosSubmitting, setOpenPosSubmitting] = useState(false);
    const [showAdvanced, setShowAdvanced] = useState(false);

    const [searchParams] = useSearchParams();

    const didAutoAnalyze = useRef(false);
    const urlTickerRef = useRef<string | null>(null);
    const urlDirRef = useRef<string | null>(null);

    // Seed from URL params on mount, auto-trigger analyze if both provided
    useEffect(() => {
        const urlTicker = searchParams.get('ticker');
        const urlDir = searchParams.get('direction') as 'BULL' | 'BEAR' | null;
        const urlStrategy = searchParams.get('strategy');
        urlTickerRef.current = urlTicker;
        urlDirRef.current = urlDir;
        if (urlTicker) setTicker(urlTicker.toUpperCase());
        if (urlDir === 'BULL' || urlDir === 'BEAR') setDirection(urlDir);
        if (urlStrategy === 'swing' || urlStrategy === 'shortTerm') setActiveStrategy(urlStrategy);
        tickerRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // run once on mount

    // Auto-analyze when URL params are present and state has settled
    useEffect(() => {
        if (didAutoAnalyze.current) return;
        if (!urlTickerRef.current || !urlDirRef.current) return;
        if (ticker === urlTickerRef.current.toUpperCase()) {
            // State has settled with URL value — safe to analyze
            didAutoAnalyze.current = true;
            handleAnalyze();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ticker]);

    // Persist selector state to localStorage
    useEffect(() => {
        localStorage.setItem(LS_KEY, JSON.stringify({ direction, targetDte, spreadWidth }));
    }, [direction, targetDte, spreadWidth]);

    // Reset defaults when strategy profile changes
    useEffect(() => {
        const p = getProfile(activeStrategy);
        setTargetDte(p.dtePeak);
        setSpreadWidth(p.defaultWidth);
    }, [activeStrategy]);


    const handleAnalyze = async () => {
        if (!ticker) return;
        setLoading(true);
        setError('');
        setResult(null);
        setExpandedCard(null);
        setShowAdvanced(false);
        setOpenPosIdx(null);

        try {
            const url = `/api/strategy-recommend?ticker=${ticker}&direction=${direction}&targetDte=${targetDte}&spreadWidth=${spreadWidth}&strategy=${activeStrategy}`;
            const res = await fetch(url);
            const text = await res.text();
            let data: unknown;
            try {
                data = text ? JSON.parse(text) : {};
            } catch (parseErr) {
                const snippet = (text || '').trim().slice(0, 100);
                const friendly = snippet
                    ? `Server returned non-JSON (${res.status}): ${snippet}${(text || '').length > 100 ? '…' : ''}`
                    : `Server returned non-JSON (${res.status}). Check network or try again.`;
                throw new Error(friendly);
            }

            if (!res.ok) {
                const errPayload = data as { message?: string; error?: string };
                throw new Error(errPayload?.message || errPayload?.error || 'Failed to fetch recommendations');
            }
            const resultData = data as StrategyResult;
            setResult(resultData);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    const isSpread = (rec: Recommendation): rec is SpreadRecommendation => {
        return 'shortLeg' in rec && 'longLeg' in rec && 'width' in rec;
    };

    const getScoreColor = (score: number) => {
        if (score >= 75) return 'text-green-400';
        if (score >= 60) return 'text-yellow-400';
        if (score >= 45) return 'text-orange-400';
        return 'text-red-400';
    };

    const getCategoryBadge = (category: StrategyCategory | string) => {
        switch (category) {
            case 'CREDIT_SPREAD': return { label: 'Credit', color: 'bg-red-500/20 text-red-400 border-red-500/30' };
            case 'DEBIT_SPREAD': return { label: 'Debit', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' };
            case 'SINGLE_LEG': return { label: 'Long', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30' };
            default: return { label: category, color: 'bg-gray-500/20 text-gray-400 border-gray-500/30' };
        }
    };

    const handleAddToWatchlist = async (rec: Recommendation) => {
        if (!onAddToWatchlist || !result) return;

        const isSpreadType = isSpread(rec);

        // Compute trade profile at entry (retrospective categorization)
        const entryIsCredit = result.recommendedStrategy === 'CREDIT_SPREAD' || result.regime.mode === 'CREDIT';
        const entryIvRegime = result.regime.mode === 'CREDIT' ? 'backwardation' : result.regime.mode === 'DEBIT' ? 'contango' : 'flat';
        const entryDelta = isSpreadType
            ? Math.abs((rec as SpreadRecommendation).shortLeg?.delta || 0.3)
            : Math.abs((rec as SingleLegRecommendation).delta || 0.3);
        const entryGT = !isSpreadType && (rec as SingleLegRecommendation).gamma != null
            ? ((rec as SingleLegRecommendation).gamma || 0) / Math.max(Math.abs((rec as SingleLegRecommendation).theta || 1), 0.001)
            : 0;
        const entryTradeProfile = classifyTradeProfile({
            isCredit: entryIsCredit,
            ivRegime: entryIvRegime as 'contango' | 'backwardation' | 'flat',
            ivRank: result.regime.ivRank,
            dte: result.context.targetDte,
            gtRatio: entryGT,
            delta: entryDelta,
        });
        const entryIvRegimeEntry = entryIvRegime;
        const entryIvRank = result.regime.ivRank != null ? result.regime.ivRank : undefined;

        let legs: { side: string; strike: number; type: string; expiration: string }[] | undefined = undefined;
        if (isSpreadType) {
            const spreadRec = rec as SpreadRecommendation;
            const legType = spreadRec.type.includes('Call') ? 'Call' : 'Put';
            legs = [
                {
                    side: 'short',
                    strike: spreadRec.shortLeg.strike,
                    type: legType,
                    expiration: spreadRec.shortLeg.expiration
                },
                {
                    side: 'long',
                    strike: spreadRec.longLeg.strike,
                    type: legType,
                    expiration: spreadRec.longLeg.expiration
                }
            ];
        }

        const item: WatchlistItem = {
            ticker: result.context.ticker,
            strike: isSpreadType ? (rec as SpreadRecommendation).shortLeg.strike : (rec as SingleLegRecommendation).strike,
            type: rec.type,
            expiration: isSpreadType ? (rec as SpreadRecommendation).shortLeg.expiration : (rec as SingleLegRecommendation).expiration,
            setup: 'Algorithm Rec',
            entry_score: rec.score,
            ideal_entry: isSpreadType ? ((rec as SpreadRecommendation).netCredit ?? (rec as SpreadRecommendation).netDebit) : (rec as SingleLegRecommendation).price,
            target_price: 0,
            stop_reason: `Algorithm Rec: ${rec.whyThis}`,
            notes: isSpreadType
                ? `EV: $${(rec as SpreadRecommendation).expectedValue ?? '0'}. Width: $${(rec as SpreadRecommendation).width}`
                : `Delta: ${(rec as SingleLegRecommendation).delta}`,
            legs: legs as WatchlistItem['legs'],
            tech_score: techScoreTier?.value ?? undefined,
            tech_score_source: 'manual',
            direction,
            trade_profile: entryTradeProfile,
            iv_rank_entry: entryIvRank,
            iv_regime_entry: entryIvRegimeEntry,
            spread_width: isSpread(rec) ? rec.width : undefined,
        };

        await onAddToWatchlist(item);
        setExpandedCard(null);
    };

    const handleOpenPosition = useCallback(async (rec: Recommendation) => {
        if (!onAddDirect || !result) return;
        setOpenPosSubmitting(true);

        const isSpreadType = isSpread(rec);

        // Reuse same trade profile logic as watchlist
        const entryIsCredit = result.recommendedStrategy === 'CREDIT_SPREAD' || result.regime.mode === 'CREDIT';
        const entryIvRegime = result.regime.mode === 'CREDIT' ? 'backwardation' : result.regime.mode === 'DEBIT' ? 'contango' : 'flat';
        const entryDelta = isSpreadType
            ? Math.abs((rec as SpreadRecommendation).shortLeg?.delta || 0.3)
            : Math.abs((rec as SingleLegRecommendation).delta || 0.3);
        const entryGT = !isSpreadType && (rec as SingleLegRecommendation).gamma != null
            ? ((rec as SingleLegRecommendation).gamma || 0) / Math.max(Math.abs((rec as SingleLegRecommendation).theta || 1), 0.001)
            : 0;
        const entryTradeProfile = classifyTradeProfile({
            isCredit: entryIsCredit,
            ivRegime: entryIvRegime as 'contango' | 'backwardation' | 'flat',
            ivRank: result.regime.ivRank,
            dte: result.context.targetDte,
            gtRatio: entryGT,
            delta: entryDelta,
        });

        let legs: PositionLeg[] | undefined = undefined;
        if (isSpreadType) {
            const spreadRec = rec as SpreadRecommendation;
            const legType = spreadRec.type.includes('Call') ? 'Call' : 'Put';
            legs = [
                { strike: spreadRec.shortLeg.strike, type: legType, side: 'short', expiration: spreadRec.shortLeg.expiration },
                { strike: spreadRec.longLeg.strike, type: legType, side: 'long', expiration: spreadRec.longLeg.expiration }
            ];
        }

        const item: DirectAddItem = {
            ticker: result.context.ticker,
            strike: isSpreadType ? (rec as SpreadRecommendation).shortLeg.strike : (rec as SingleLegRecommendation).strike,
            type: rec.type,
            expiration: isSpreadType ? (rec as SpreadRecommendation).shortLeg.expiration : (rec as SingleLegRecommendation).expiration,
            setup: 'Algorithm Rec',
            entry_score: rec.score,
            stop_reason: `Algorithm Rec: ${rec.whyThis}`,
            quantity: parseInt(openPosQty) || 1,
            entry_price: parseFloat(openPosPrice) || 0,
            legs,
            owner: openPosOwner,
            tech_score: techScoreTier?.value ?? undefined,
            tech_score_source: 'manual',
            direction,
            trade_profile: entryTradeProfile,
            iv_rank_entry: result.regime.ivRank != null ? result.regime.ivRank : undefined,
            iv_regime_entry: entryIvRegime,
            max_risk_entry: isSpreadType ? (rec as SpreadRecommendation).maxRisk * 100 : undefined,
            spread_width: isSpread(rec) ? rec.width : undefined,
        };

        await onAddDirect(item);
        setOpenPosSubmitting(false);
        setOpenPosIdx(null);
        setOpenPosQty('');
        setOpenPosPrice('');
        setExpandedCard(null);
    }, [onAddDirect, result, openPosQty, openPosPrice, openPosOwner, techScoreTier, direction, isSpread]);

    return (
        <div className="fade-in pb-24 sm:pb-0 font-sans">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <Activity className="text-accent-green" />
                    Spread Builder
                </h1>
                <p className="text-gray-400 text-sm mt-1">{`Credit spread recommendations · ${profile.subtitle}`}</p>
            </div>

            {/* Input Panel */}
            <div className="bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl p-4 sm:p-6 mb-6 shadow-sm">
                <div className="flex flex-col gap-4">
                    {/* Portfolio / Risk Settings */}
                    <div className="border border-[#2A2A2A] rounded-lg overflow-hidden">
                        <button
                            type="button"
                            onClick={() => setShowSettings(!showSettings)}
                            className="w-full flex items-center justify-between px-4 py-2.5 bg-[#0a0a0a] hover:bg-[#111] transition-colors text-left"
                        >
                            <span className="flex items-center gap-2 text-sm font-medium text-gray-300">
                                <Settings2 size={16} className="text-accent-green" />
                                Portfolio / Risk Settings
                            </span>
                            <ChevronDown size={18} className={`text-gray-500 transition-transform ${showSettings ? 'rotate-180' : ''}`} />
                        </button>
                        {showSettings && (
                            <div className="p-4 bg-[#111] border-t border-[#2A2A2A]">
                                <PortfolioSettingsForm variant="full" />
                            </div>
                        )}
                    </div>

                    {/* Row 1: Ticker + Direction + Analyze (always visible, minimum viable input) */}
                    <div className="flex flex-col md:flex-row gap-3 items-end">
                        <div className="flex-1 min-w-0">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Ticker</label>
                            <div className="relative">
                                <input
                                    ref={tickerRef}
                                    type="text"
                                    value={ticker}
                                    onChange={(e) => setTicker(e.target.value.toUpperCase())}
                                    className="w-full bg-[#000] border border-[#333] text-white rounded-lg pl-10 pr-4 py-3 focus:outline-none focus:border-accent-green text-xl font-black tracking-wide placeholder-gray-600 transition-colors"
                                    placeholder="SPY"
                                    onKeyDown={(e) => e.key === 'Enter' && handleAnalyze()}
                                />
                                <Search className="absolute left-3 top-3.5 text-gray-500" size={20} />
                            </div>
                        </div>
                        <div className="w-44">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Direction</label>
                            <div className="grid grid-cols-2 gap-2 bg-[#000] p-1 rounded-lg border border-[#333]">
                                {(['BULL', 'BEAR'] as const).map((d) => (
                                    <button
                                        key={d}
                                        type="button"
                                        onClick={() => setDirection(d)}
                                        className={`py-2.5 rounded text-xs font-bold transition-all ${direction === d
                                            ? d === 'BULL'
                                                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                                                : 'bg-red-500/20 text-red-400 border border-red-500/30'
                                            : 'text-gray-500 hover:text-gray-300'
                                            }`}
                                    >
                                        {d === 'BULL' ? '🐂' : '🐻'} {d}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <button
                            onClick={handleAnalyze}
                            disabled={loading || !ticker}
                            className="bg-purple-600 hover:bg-purple-500 text-white font-bold py-3 px-6 rounded-lg transition-all shadow-lg shadow-purple-900/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-w-[140px]"
                        >
                            {loading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Activity size={20} />}
                            Analyze
                        </button>
                    </div>

                    {/* Row 2: TV Score Tier */}
                    <div>
                        <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">TV Score Tier</label>
                        <div className="flex gap-2">
                            {[
                                { label: 'S', value: 92, range: '90+', color: 'text-emerald-400 border-emerald-500/50 bg-emerald-500/20' },
                                { label: 'A', value: 85, range: '80–89', color: 'text-green-400 border-green-500/50 bg-green-500/15' },
                                { label: 'B', value: 75, range: '70–79', color: 'text-yellow-400 border-yellow-500/50 bg-yellow-500/15' },
                            ].map((tier) => (
                                <button
                                    key={tier.label}
                                    type="button"
                                    onClick={() => setTechScoreTier(techScoreTier?.label === tier.label ? null : tier)}
                                    className={`px-4 py-2 rounded-lg text-center transition-all border ${techScoreTier?.label === tier.label
                                        ? `${tier.color} shadow-sm`
                                        : 'text-gray-500 border-[#333] bg-[#000] hover:text-gray-300'
                                        }`}
                                >
                                    <div className="text-sm font-black">{tier.label}</div>
                                    <div className="text-[9px] font-normal opacity-70">{tier.range}</div>
                                </button>
                            ))}
                            <div className="ml-2 flex items-center text-xs text-gray-500">
                                {techScoreTier ? <span className="text-accent-green font-medium">{techScoreTier.label}-tier selected</span> : 'none selected'}
                            </div>
                        </div>
                    </div>

                    {/* Row 3: DTE + Spread Width */}
                    <div className="flex flex-col md:flex-row gap-4 items-end">
                        <div className="flex-1">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Target DTE</label>
                            <div className="grid grid-cols-3 gap-1.5 bg-[#000] p-1 rounded-lg border border-[#333]">
                                {profile.dteOptions.map((opt) => (
                                    <button
                                        key={opt.val}
                                        type="button"
                                        onClick={() => setTargetDte(opt.val)}
                                        className={`py-1.5 rounded px-1 text-xs font-bold transition-all ${targetDte === opt.val
                                            ? 'bg-[#3A3A3C] text-white shadow-sm'
                                            : 'text-gray-500 hover:text-gray-300'
                                            }`}
                                    >
                                        <div className="flex flex-col items-center">
                                            <span className="text-[10px]">{opt.label}</span>
                                            <span className="text-[9px] font-normal opacity-70">{opt.text}</span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="w-full md:w-44">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Spread Width</label>
                            <div className="grid grid-cols-4 gap-1.5 bg-[#000] p-1 rounded-lg border border-[#333]">
                                {profile.widthOptions.map((opt) => (
                                    <button
                                        key={opt.val}
                                        type="button"
                                        onClick={() => setSpreadWidth(opt.val)}
                                        className={`py-2 rounded px-1 text-xs font-bold transition-all ${spreadWidth === opt.val
                                            ? 'bg-[#3A3A3C] text-white shadow-sm'
                                            : 'text-gray-500 hover:text-gray-300'
                                            }`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {error && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl mb-6 flex items-center gap-3">
                    <AlertCircle size={24} />
                    <span className="font-medium">{error}</span>
                </div>
            )}

            {/* Auto-backfill notice: shown when ticker's IV history was just backfilled from RV proxy */}
            {result?.autoBackfillTriggered && (
                <div className="bg-blue-500/10 border border-blue-500/30 text-blue-300 p-3 rounded-xl mb-4 flex items-start gap-3">
                    <RefreshCw size={16} className="mt-0.5 shrink-0 text-blue-400" />
                    <div className="text-xs text-blue-400/80 leading-relaxed">
                        IV history for <strong>{result.context.ticker}</strong> was auto-backfilled from realized volatility (~{result.regime.ivRankSampleDays || 0}d).
                        IV Rank shown as <span className="text-yellow-400">(est.)</span> — live IV snapshots will replace over time.
                    </div>
                </div>
            )}

            {/* CBOE data source notice — escalated warning when scores are unreliable */}
            {result?.dataSource === 'CBOE' && (
                <div className={`border p-3 rounded-xl mb-4 flex items-center gap-3 ${
                    result?.scoresReliable === false
                        ? 'bg-red-500/15 border-red-500/40 text-red-300'
                        : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                }`}>
                    <AlertCircle size={16} className={`shrink-0 ${result?.scoresReliable === false ? 'text-red-400' : 'text-amber-400'}`} />
                    <span className="text-xs font-medium">
                        {result?.scoresReliable === false ? (
                            <>
                                <span className="font-bold text-red-200">Scores Unreliable — CBOE (No Greeks)</span>
                                {' '}— CBOE data has no real Greeks. All LOQ/CSQ scores are ~50 (random).
                                Do NOT act on these scores. Set <code className="bg-black/40 px-1 rounded text-red-300">DATA_SOURCE=ORATS</code> for real scoring.
                            </>
                        ) : (
                            <>
                                <span className="font-bold text-amber-200">Data Source: CBOE</span>
                                {' '}— Options quotes are <span className="font-bold">15 minutes delayed</span>.
                                For real-time Greeks &amp; IV, set <code className="bg-black/40 px-1 rounded text-amber-300">DATA_SOURCE=ORATS</code> in your environment.
                            </>
                        )}
                    </span>
                </div>
            )}

            {/* Degraded data warning: >50% of options have zero Greeks */}
            {result?.dataQuality === 'degraded' && (
                <div className="bg-yellow-500/10 border border-yellow-500/40 text-yellow-300 p-3 rounded-xl mb-4 flex items-center gap-3">
                    <AlertCircle size={16} className="shrink-0 text-yellow-400" />
                    <span className="text-xs font-medium">
                        <span className="font-bold text-yellow-200">Degraded Data Quality</span>
                        {' '}— More than half of the options in this chain have zero Greeks.
                        LOQ scores and sizing suggestions may be unreliable. Try refreshing or waiting for updated chain data.
                    </span>
                </div>
            )}

            {/* Stale quote warning: quotes older than 5 minutes */}
            {result?.quoteFreshness?.isStale && (
                <div className="bg-orange-500/10 border border-orange-500/40 text-orange-300 p-3 rounded-xl mb-4 flex items-center gap-3">
                    <AlertCircle size={16} className="shrink-0 text-orange-400" />
                    <span className="text-xs font-medium">
                        <span className="font-bold text-orange-200">Stale Quotes</span>
                        {' '}— {result.quoteFreshness.staleQuotes} options have quotes older than 5 minutes
                        (oldest: {Math.round((result.quoteFreshness.oldestQuoteAgeMs || 0) / 60000)}min).
                        Scores and greeks may not reflect current market. Consider refreshing.
                    </span>
                </div>
            )}

            {/* Results */}
            {result && (
                <div className="space-y-6 animate-fade-in">
                    {/* Regime Card */}
                    {(() => {
                        // Compute Trade Profile from result + user inputs
                        const isCredit = result.recommendedStrategy === 'CREDIT_SPREAD' || result.regime.mode === 'CREDIT';
                        const ivRegime = result.regime.mode === 'CREDIT' ? 'backwardation' : result.regime.mode === 'DEBIT' ? 'contango' : 'flat';
                        const recs = (result.strategies.TARGET_STRATEGY as Recommendation[]) || [];
                        const topRec = recs[0];
                        const topDelta = topRec
                            ? isSpread(topRec) ? Math.abs((topRec as SpreadRecommendation).shortLeg?.delta || 0.3)
                                : Math.abs((topRec as SingleLegRecommendation).delta || 0.3)
                            : 0.3;
                        const topGT = topRec && !isSpread(topRec) && (topRec as SingleLegRecommendation).gamma != null
                            ? ((topRec as SingleLegRecommendation).gamma || 0) / Math.max(Math.abs((topRec as SingleLegRecommendation).theta || 1), 0.001)
                            : 0;
                        const tradeProfile = classifyTradeProfile({
                            isCredit,
                            ivRegime: ivRegime as 'contango' | 'backwardation' | 'flat',
                            ivRank: result.regime.ivRank,
                            dte: result.context.targetDte,
                            gtRatio: topGT,
                            delta: topDelta,
                        });
                        const profileColors: Record<string, string> = {
                            'Gamma Burst': 'bg-purple-500/15 text-purple-300 border-purple-500/30',
                            'Delta Trend': 'bg-blue-500/15 text-blue-300 border-blue-500/30',
                            'Theta Harvest': 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
                            'Vega Expansion': 'bg-amber-500/15 text-amber-300 border-amber-500/30',
                            'Vega Crush': 'bg-orange-500/15 text-orange-300 border-orange-500/30',
                        };
                        const profileIcons: Record<string, string> = {
                            'Gamma Burst': '⚡',
                            'Delta Trend': '→',
                            'Theta Harvest': 'θ',
                            'Vega Expansion': '↑V',
                            'Vega Crush': '↓V',
                        };
                        return (
                            <div className={`border rounded-xl p-4 sm:p-5 relative overflow-hidden ${result.regime.mode === 'CREDIT' ? 'bg-red-900/10 border-red-500/30' :
                                result.regime.mode === 'DEBIT' ? 'bg-green-900/10 border-green-500/30' :
                                    'bg-[#1C1C1E] border-[#2A2A2A]'
                                }`}>
                                <div className="flex flex-col gap-4 relative z-10">
                                    {/* Upper half: Ticker + explanation */}
                                    <div className="min-w-0">
                                        <h2 className="text-xl sm:text-2xl font-black text-white flex items-center gap-2 sm:gap-3 flex-wrap">
                                            {result.context.ticker}
                                            <span className="text-base sm:text-lg font-normal text-gray-400 font-mono">${(result.context.currentPrice || 0).toFixed(2)}</span>
                                            <span className={`text-xs font-bold px-2 py-0.5 rounded border ${result.context.direction === 'BULL' ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-red-500/20 text-red-400 border-red-500/30'
                                                }`}>
                                                {result.context.direction} {result.context.direction === 'BULL' ? '🐂' : '🐻'}
                                            </span>
                                            <span className={`text-xs font-bold px-2 py-0.5 rounded border ${profileColors[tradeProfile]}`}>
                                                {profileIcons[tradeProfile]} {tradeProfile}
                                            </span>
                                        </h2>
                                        <p className={`mt-2 font-medium flex items-center gap-2 text-sm sm:text-base ${result.regime.mode === 'CREDIT' ? 'text-red-400' :
                                            result.regime.mode === 'DEBIT' ? 'text-green-400' : 'text-gray-300'
                                            }`}>
                                            {result.regime.mode === 'CREDIT' && <TrendingDown size={18} />}
                                            {result.regime.mode === 'DEBIT' && <TrendingUp size={18} />}
                                            {result.regime.advice}
                                        </p>
                                        {result.regime.adviceDetail && (
                                            <p className="mt-2 sm:mt-3 text-xs sm:text-sm text-gray-400 leading-relaxed max-w-2xl">
                                                {result.regime.adviceDetail}
                                            </p>
                                        )}
                                    </div>

                                    {/* Earnings + Implied Move context badges */}
                                    {(() => {
                                        // daysUntilEarnings=0 with impErnMvPct=0 or null is likely an ETF/no-earnings ticker
                                        const hasRealEarnings = result.context.daysUntilEarnings != null
                                            && result.context.daysUntilEarnings > 0
                                            || (result.context.daysUntilEarnings === 0 && result.context.impErnMvPct != null && result.context.impErnMvPct > 0.5);
                                        const hasImpliedMove = result.context.impliedMovePct != null && result.context.impliedMovePct > 0;
                                        if (!hasRealEarnings && !hasImpliedMove) return null;
                                        return (
                                            <div className="flex flex-wrap items-center gap-2 text-xs">
                                                {hasRealEarnings && (
                                                    <span className={`font-bold px-2 py-0.5 rounded border ${result.context.daysUntilEarnings! <= 7
                                                        ? 'bg-yellow-500/15 border-yellow-500/30 text-yellow-400'
                                                        : 'bg-gray-500/10 border-gray-500/30 text-gray-400'
                                                        }`}>
                                                        Earnings in {result.context.daysUntilEarnings}d
                                                    </span>
                                                )}
                                                {hasRealEarnings && result.context.impErnMvPct != null && result.context.impErnMvPct > 0 && (
                                                    <span className="font-mono text-yellow-300 bg-yellow-500/10 px-2 py-0.5 rounded border border-yellow-500/20">
                                                        &plusmn;{result.context.impErnMvPct.toFixed(1)}% earnings move
                                                    </span>
                                                )}
                                                {hasImpliedMove && (
                                                    <span className="font-mono text-gray-300 bg-white/5 px-2 py-0.5 rounded border border-white/10">
                                                        &plusmn;{result.context.impliedMovePct!.toFixed(1)}% implied
                                                        <span className="text-gray-500 ml-1">
                                                            (${(result.context.currentPrice * (1 - result.context.impliedMovePct! / 100)).toFixed(0)}–${(result.context.currentPrice * (1 + result.context.impliedMovePct! / 100)).toFixed(0)})
                                                        </span>
                                                    </span>
                                                )}
                                            </div>
                                        );
                                    })()}

                                    {/* Takeover warning — options are mispriced during M&A */}
                                    {result.context.tkOver && (
                                        <div className="flex items-center gap-2 text-xs bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300">
                                            <AlertCircle size={14} className="shrink-0" />
                                            <span>
                                                <strong>Takeover target</strong> — options pricing may be unreliable during active M&A activity. Exercise caution with all strategies.
                                            </span>
                                        </div>
                                    )}

                                    {/* Rising IV warning — prominent, above indicators */}
                                    {result.regime.ivTrend === 'rising' && result.regime.mode === 'CREDIT' && (
                                        <div className="flex items-center gap-2 text-xs bg-orange-500/10 border border-orange-500/30 rounded-lg px-3 py-2 text-orange-300">
                                            <AlertCircle size={14} className="shrink-0" />
                                            <span>
                                                <strong>IV is rising ({result.regime.iv5dChange != null ? `${result.regime.iv5dChange > 0 ? '+' : ''}${result.regime.iv5dChange}pp` : '5d'})</strong> — selling premium into rising IV risks mark-to-market losses. Credit spreads are still regime-appropriate (high IV rank, backwardation) but consider <strong>wider strikes</strong> or <strong>shorter DTE</strong> to reduce vega exposure.
                                            </span>
                                        </div>
                                    )}

                                    {/* Technical indicators — single compact row */}
                                    <div className="border-t border-[#333] pt-4 sm:pt-5 mt-2">
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider">Technical indicators</div>
                                            {result.regime.ivTrend && (
                                                <div className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded border ${result.regime.ivTrend === 'rising'
                                                    ? 'bg-orange-500/10 border-orange-500/30 text-orange-400'
                                                    : result.regime.ivTrend === 'falling'
                                                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                                                        : 'bg-gray-500/10 border-gray-500/30 text-gray-400'
                                                    }`}>
                                                    IV {result.regime.ivTrend === 'rising' ? '▲' : result.regime.ivTrend === 'falling' ? '▼' : '—'}
                                                    {result.regime.iv5dChange != null && (
                                                        <span className="font-mono opacity-80">{result.regime.iv5dChange > 0 ? '+' : ''}{result.regime.iv5dChange}pp</span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3 sm:gap-4">
                                            <div>
                                                <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                    IV Rank
                                                    <Tooltip label="" explanation="IV Rank: current IV30 in 252d min–max range (0–100%). Low = IV cheap (buyers); high = IV expensive (sellers)." />
                                                </div>
                                                <div className={`text-lg sm:text-xl font-mono font-bold ${result.regime.ivRank != null ? (result.regime.ivRank < 0.3 ? 'text-emerald-400' : result.regime.ivRank > 0.7 ? 'text-amber-400' : 'text-white') : 'text-gray-500'}`}>
                                                    {result.regime.ivRank != null ? `${(result.regime.ivRank * 100).toFixed(0)}%` : 'N/A'}
                                                    {result.regime.ivRank != null && result.regime.ivRankSource === 'rv_proxy' && (
                                                        <span className="text-[9px] text-yellow-400/70 ml-0.5">est</span>
                                                    )}
                                                </div>
                                                <div className="text-[9px] text-gray-600 font-mono">
                                                    {result.regime.ivRankSampleDays != null && result.regime.ivRankSampleDays > 0 ? `${result.regime.ivRankSampleDays}d window` : ''}
                                                </div>
                                            </div>
                                            <div>
                                                <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                    IV Ratio
                                                    <Tooltip label="" explanation="IV30/IV90 term structure. &lt;1 = contango (sell premium), &gt;1 = backwardation (buy premium)." />
                                                </div>
                                                <div className={`text-lg sm:text-xl font-mono font-bold ${(result.regime.ivRatio ?? 1) < 0.95 ? 'text-emerald-400' : (result.regime.ivRatio ?? 1) > 1.05 ? 'text-amber-400' : 'text-white'}`}>
                                                    {result.regime.ivRatio != null ? result.regime.ivRatio.toFixed(2) : 'N/A'}
                                                </div>
                                                <div className="text-[9px] text-gray-600 font-mono">
                                                    {result.regime.iv30 != null && result.regime.iv90 != null
                                                        ? `${result.regime.iv30}% / ${result.regime.iv90}%`
                                                        : ''}
                                                </div>
                                            </div>
                                            <div>
                                                <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                    IV/RV
                                                    <Tooltip label="" explanation="IV30 vs realized vol. &gt;1 = implied expensive (sell); &lt;1 = implied cheap (buy)." />
                                                </div>
                                                <div className={`text-lg sm:text-xl font-mono font-bold ${(result.regime.ivRvRatio ?? 1) > 1.1 ? 'text-amber-400' : (result.regime.ivRvRatio ?? 1) < 0.9 ? 'text-emerald-400' : 'text-white'}`}>
                                                    {result.regime.ivRvRatio != null ? result.regime.ivRvRatio.toFixed(2) : 'N/A'}
                                                </div>
                                                <div className="text-[9px] text-gray-600 font-mono">
                                                    {result.regime.rv30 != null ? `RV ${result.regime.rv30}%` : ''}
                                                </div>
                                            </div>
                                            {result.context.putCallRatio != null && (
                                                <div>
                                                    <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                        P/C
                                                        <Tooltip label="" explanation="Put/Call volume ratio. &gt;1.2 = bearish (more puts), &lt;0.8 = bullish (more calls)." />
                                                    </div>
                                                    <div className={`text-lg sm:text-xl font-mono font-bold ${result.context.putCallRatio > 1.2 ? 'text-amber-400' : result.context.putCallRatio < 0.8 ? 'text-emerald-400' : 'text-white'}`}>
                                                        {result.context.putCallRatio.toFixed(2)}
                                                    </div>
                                                    <div className="text-[9px] text-gray-600 font-mono">
                                                        {result.context.putCallRatio > 1.2 ? 'bearish' : result.context.putCallRatio < 0.8 ? 'bullish' : 'neutral'}
                                                    </div>
                                                </div>
                                            )}
                                            {result.context.contango != null && (
                                                <div>
                                                    <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                        Term
                                                        <Tooltip label="" explanation="Contango (positive) = front IV &lt; back IV, sell premium friendly. Backwardation (negative) = front IV &gt; back IV." />
                                                    </div>
                                                    <div className={`text-lg sm:text-xl font-mono font-bold ${result.context.contango > 0 ? 'text-emerald-400' : result.context.contango < 0 ? 'text-amber-400' : 'text-white'}`}>
                                                        {result.context.contango > 0 ? '+' : ''}{result.context.contango.toFixed(2)}
                                                    </div>
                                                    <div className="text-[9px] text-gray-600 font-mono">
                                                        {result.context.contango > 0.01 ? 'contango' : result.context.contango < -0.01 ? 'backwdn' : 'flat'}
                                                    </div>
                                                </div>
                                            )}
                                            {result.regime.slope != null && result.regime.slopeTier && result.regime.slopeTier !== 'flat' && (
                                                <div>
                                                    <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider mb-1">Slope</div>
                                                    <div className="text-lg sm:text-xl font-mono font-bold text-white">
                                                        {(result.regime.slope * 100).toFixed(1)}%
                                                    </div>
                                                    <div className="text-[9px] text-gray-600 font-mono">
                                                        {result.regime.slopeTier.replace(/_/g, ' ')}
                                                    </div>
                                                </div>
                                            )}
                                            {result.regime.ivPercentile != null && result.regime.ivPercentile !== result.regime.ivRank && (
                                                <div>
                                                    <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                        IV %
                                                        <Tooltip label="" explanation="IV Percentile: % of past days with IV30 below current." />
                                                    </div>
                                                    <div className={`text-lg sm:text-xl font-mono font-bold ${result.regime.ivPercentile < 0.3 ? 'text-emerald-400' : result.regime.ivPercentile > 0.7 ? 'text-amber-400' : 'text-white'}`}>
                                                        {(result.regime.ivPercentile * 100).toFixed(0)}%
                                                    </div>
                                                </div>
                                            )}
                                            {result.context.volForecast != null && (
                                                <div>
                                                    <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                        Vol Fcst
                                                        <Tooltip label="" explanation="ORATS 20-day vol forecast. Compared to IV30 — if forecast &gt; IV, vol may expand (favor debit). R² = forecast quality." />
                                                    </div>
                                                    <div className={`text-lg sm:text-xl font-mono font-bold ${
                                                        result.regime.iv30 != null
                                                            ? (result.context.volForecast.fcst20d > result.regime.iv30 * 100 * 1.05 ? 'text-amber-400' : result.context.volForecast.fcst20d < result.regime.iv30 * 100 * 0.95 ? 'text-emerald-400' : 'text-white')
                                                            : 'text-white'
                                                    }`}>
                                                        {result.context.volForecast.fcst20d.toFixed(1)}%
                                                    </div>
                                                    <div className="text-[9px] text-gray-600 font-mono">
                                                        {result.context.volForecast.r2 != null ? `R²=${result.context.volForecast.r2.toFixed(2)}` : ''}
                                                    </div>
                                                </div>
                                            )}
                                            {result.context.avgOptVolu20d != null && result.context.avgOptVolu20d > 0 && (
                                                <div>
                                                    <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                        Opt Vol
                                                        <Tooltip label="" explanation="20-day average option volume (contracts/day). Higher = better fills and tighter spreads." />
                                                    </div>
                                                    <div className={`text-lg sm:text-xl font-mono font-bold ${result.context.avgOptVolu20d < 1000 ? 'text-amber-400' : 'text-white'}`}>
                                                        {result.context.avgOptVolu20d >= 1000
                                                            ? `${(result.context.avgOptVolu20d / 1000).toFixed(1)}K`
                                                            : result.context.avgOptVolu20d.toFixed(0)}
                                                    </div>
                                                    <div className="text-[9px] text-gray-600 font-mono">
                                                        {result.context.avgOptVolu20d < 1000 ? 'low liq' : result.context.avgOptVolu20d < 10000 ? 'moderate' : 'liquid'}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* Target Recommendations */}
                    {(() => {
                        const allRecs = (result.strategies.TARGET_STRATEGY as Recommendation[]) || [];
                        const spreadRecs = allRecs.filter(r => 'shortLeg' in r);
                        const singleRecs = allRecs.filter(r => !('shortLeg' in r));
                        const renderCard = (rec: Recommendation, idx: number) => {
                                    const displayScore = rec.score;
                                    const category = (rec as unknown as UnifiedCandidateType).strategyCategory || null;
                                    return (
                                        <div
                                            key={idx}
                                            className={`bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl overflow-hidden transition-all duration-300 ${expandedCard === idx ? 'ring-1 ring-accent-green/50 shadow-lg shadow-green-900/10' : 'hover:border-[#444]'
                                                }`}
                                        >
                                            {/* Card Header (Clickable) */}
                                            <div
                                                className="p-4 sm:p-5 cursor-pointer flex flex-col md:flex-row justify-between items-start md:items-center gap-3 sm:gap-4"
                                                onClick={() => setExpandedCard(expandedCard === idx ? null : idx)}
                                            >
                                                <div className="flex-1 min-w-0">
                                                    <div className="flex items-center gap-2 sm:gap-3 mb-1">
                                                        <div className={`text-3xl sm:text-4xl font-black ${getScoreColor(displayScore)}`}>{displayScore}</div>
                                                        <div className="min-w-0">
                                                            <div className="font-bold text-base sm:text-lg text-white flex items-center gap-1.5 sm:gap-2 flex-wrap">
                                                                <span className="truncate">{rec.type}</span>
                                                                {category && (() => {
                                                                    const badge = getCategoryBadge(category);
                                                                    return (
                                                                        <span className={`text-[9px] sm:text-[10px] font-bold px-1.5 sm:px-2 py-0.5 rounded border shrink-0 ${badge.color}`}>
                                                                            {badge.label}
                                                                        </span>
                                                                    );
                                                                })()}
                                                                {rec.score >= 0 && (
                                                                    <span className="text-[10px] sm:text-xs text-gray-500 font-mono shrink-0">(score: {rec.score})</span>
                                                                )}
                                                                {isSpread(rec) && (
                                                                    <span className="text-xs sm:text-sm font-mono text-gray-400 bg-white/5 px-1.5 sm:px-2 py-0.5 rounded border border-white/10 shrink-0">
                                                                        ${rec.shortLeg?.strike} / ${rec.longLeg?.strike}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="text-xs sm:text-sm text-gray-400 font-mono">
                                                                {isSpread(rec) ? (
                                                                    <span className="flex items-center gap-2">
                                                                        {rec.shortLeg?.expiration || rec.longLeg?.expiration}
                                                                    </span>
                                                                ) : (
                                                                    <span className="flex items-center gap-2">
                                                                        ${(rec as SingleLegRecommendation).strike} • {(rec as SingleLegRecommendation).expiration}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    {/* Key Metrics Row */}
                                                    <div className="flex flex-wrap gap-x-4 sm:gap-x-6 gap-y-2 mt-3 text-xs sm:text-sm">
                                                        {isSpread(rec) ? (
                                                            <>
                                                                {rec.netCredit && (
                                                                    <div className="flex flex-col">
                                                                        <span className="text-[10px] text-gray-500 uppercase font-bold">Credit</span>
                                                                        <span className="text-accent-green font-mono font-bold">${rec.netCredit}</span>
                                                                    </div>
                                                                )}
                                                                {rec.netDebit && (
                                                                    <div className="flex flex-col">
                                                                        <span className="text-[10px] text-gray-500 uppercase font-bold">Debit</span>
                                                                        <span className="text-white font-mono font-bold">${rec.netDebit}</span>
                                                                    </div>
                                                                )}
                                                                {rec.roi && (
                                                                    <div className="flex flex-col">
                                                                        <span className="text-[10px] text-gray-500 uppercase font-bold">ROI</span>
                                                                        <span className="text-accent-green font-mono font-bold">{rec.roi}%</span>
                                                                    </div>
                                                                )}
                                                                {rec.pop && (
                                                                    <div className="flex flex-col">
                                                                        <span className="text-[10px] text-gray-500 uppercase font-bold">POP</span>
                                                                        <span className="text-white font-mono font-bold">{rec.pop}%</span>
                                                                    </div>
                                                                )}
                                                                {rec.riskReward && (
                                                                    <div className="flex flex-col">
                                                                        <span className="text-[10px] text-gray-500 uppercase font-bold">R:R</span>
                                                                        <span className="text-accent-green font-mono font-bold">{rec.riskReward}</span>
                                                                    </div>
                                                                )}
                                                                {(rec as SpreadRecommendation).evHold !== undefined && (
                                                                    <div className="flex flex-col">
                                                                        <span className="text-[10px] text-gray-500 uppercase font-bold">
                                                                            EV (Hold)
                                                                        </span>
                                                                        <span className={`font-mono font-bold ${(rec as SpreadRecommendation).evHold! > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                                            ${(rec as SpreadRecommendation).evHold}
                                                                        </span>
                                                                        {(rec as SpreadRecommendation).evDaily !== undefined && (
                                                                            <span className="text-[9px] text-gray-500 font-mono">
                                                                                ${((rec as SpreadRecommendation).evDaily! * 100).toFixed(1)}¢/d
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                )}
                                                                <div className="flex flex-col">
                                                                    <span className="text-[10px] text-gray-500 uppercase font-bold">Max Risk</span>
                                                                    <span className="text-red-400 font-mono font-bold">${rec.maxRisk}</span>
                                                                </div>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <div className="flex flex-col">
                                                                    <span className="text-[10px] text-gray-500 uppercase font-bold">Price</span>
                                                                    <span className="text-white font-mono font-bold">${(rec as SingleLegRecommendation).price?.toFixed(2)}</span>
                                                                </div>
                                                                <div className="flex flex-col">
                                                                    <span className="text-[10px] text-gray-500 uppercase font-bold">Delta</span>
                                                                    <span className="text-white font-mono font-bold">{(rec as SingleLegRecommendation).delta?.toFixed(2)}</span>
                                                                </div>
                                                                <div className="flex flex-col">
                                                                    <span className="text-[10px] text-gray-500 uppercase font-bold">Gamma</span>
                                                                    <span className="text-white font-mono font-bold">{(rec as SingleLegRecommendation).gamma?.toFixed(4)}</span>
                                                                </div>
                                                                <div className="flex flex-col">
                                                                    <span className="text-[10px] text-gray-500 uppercase font-bold">Theta</span>
                                                                    <span className="text-red-400 font-mono font-bold">{(rec as SingleLegRecommendation).theta?.toFixed(3)}</span>
                                                                </div>
                                                                <div className="flex flex-col">
                                                                    <span className="text-[10px] text-gray-500 uppercase font-bold">Vega</span>
                                                                    <span className="text-white font-mono font-bold">{(rec as SingleLegRecommendation).vega?.toFixed(3)}</span>
                                                                </div>
                                                                <div className="flex flex-col">
                                                                    <span className="text-[10px] text-gray-500 uppercase font-bold">Lambda</span>
                                                                    <span className="text-accent-green font-mono font-bold">{(rec as SingleLegRecommendation).lambda?.toFixed(1)}</span>
                                                                </div>
                                                                <div className="flex flex-col">
                                                                    <span className="text-[10px] text-gray-500 uppercase font-bold">Volume</span>
                                                                    <span className="text-white font-mono font-bold">{(rec as SingleLegRecommendation).volume}</span>
                                                                </div>
                                                                <div className="flex flex-col">
                                                                    <span className="text-[10px] text-gray-500 uppercase font-bold">OI</span>
                                                                    <span className="text-white font-mono font-bold">{(rec as SingleLegRecommendation).openInterest}</span>
                                                                </div>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>

                                                <div className="text-right flex flex-col items-end gap-2">
                                                    <div className={`text-2xl transition-transform ${expandedCard === idx ? 'rotate-180' : ''}`}>
                                                        <ChevronDown size={24} className="text-gray-500" />
                                                    </div>
                                                    {isSpread(rec) && (
                                                        <div className="text-xs text-gray-500 font-mono">Width: ${rec.width}</div>
                                                    )}
                                                </div>
                                            </div>

                                            {/* Review "Why This" Banner */}
                                            <div className="bg-[#2C2C2E] px-3 sm:px-5 py-2 border-t border-[#3A3A3C] space-y-1">
                                                <div className="flex items-start gap-2">
                                                    <Info size={14} className="text-yellow-500 shrink-0 mt-0.5" />
                                                    <span className="text-xs sm:text-sm text-gray-300 italic">{rec.whyThis}</span>
                                                </div>
                                                {(() => {
                                                    const sizing = getSuggestedContracts(rec, portfolioTotal, riskPct, { useKelly: true, stopOutFraction });
                                                    const riskAtStopOut = sizing.suggestedContracts * sizing.riskPerContractAtStopOutDollars;
                                                    const riskPctActual = portfolioTotal > 0 ? (riskAtStopOut / portfolioTotal) * 100 : 0;
                                                    const budgetConsumed = sizing.riskCapDollars > 0 ? (riskAtStopOut / sizing.riskCapDollars) * 100 : 0;
                                                    return (
                                                        <div className="text-[10px] sm:text-xs text-gray-400 font-mono pl-6 leading-relaxed">
                                                            Size: <span className="text-accent-green font-bold">{sizing.suggestedContracts}</span> contracts
                                                            {sizing.suggestedContracts > 0 && (
                                                                <>
                                                                    {' '}· at-risk: <span className={`font-bold ${riskPctActual > 5 ? 'text-accent-red' : riskPctActual > 2.5 ? 'text-accent-yellow' : 'text-text-primary'}`}>{formatCurrency(riskAtStopOut)} ({riskPctActual.toFixed(1)}%)</span>
                                                                    <span className="hidden sm:inline text-gray-500"> · budget {budgetConsumed.toFixed(0)}% · max-loss/contract {formatCurrency(sizing.maxLossPerContractDollars)}</span>
                                                                </>
                                                            )}
                                                            <span className="hidden sm:inline text-gray-600"> · cap {formatCurrency(sizing.riskCapDollars)}</span>
                                                        </div>
                                                    );
                                                })()}
                                            </div>

                                            {/* Expanded Details */}
                                            {expandedCard === idx && (
                                                <div className="p-5 border-t border-[#3A3A3C] bg-black/20">
                                                    {/* Score explainability (unified score factors for TOP_PICKS) */}
                                                    {(rec as UnifiedCandidateType).factors && (rec as UnifiedCandidateType).factors!.length > 0 && (
                                                        <div className="mb-6 p-4 bg-[#252528] border border-[#3A3A3C] rounded-xl">
                                                            <ScoreFactorsView factors={(rec as UnifiedCandidateType).factors!} />
                                                        </div>
                                                    )}
                                                    {/* Analysis Section: Why this strategy/option is a good choice */}
                                                    {isSpread(rec) && rec.recommendation?.note && (
                                                        <div className="mb-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                                                            {rec.recommendation.note.includes('✅') && (
                                                                <div className="bg-green-500/5 border border-green-500/20 p-4 rounded-xl">
                                                                    <h4 className="text-xs font-bold text-green-400 uppercase mb-2 flex items-center gap-2">
                                                                        <TrendingUp size={14} />
                                                                        Why This Strategy Works
                                                                    </h4>
                                                                    <p className="text-sm text-gray-300 leading-relaxed">
                                                                        {rec.recommendation.note.split('⚠️')[0].replace('✅ Pros:', '').trim().replace(/\.$/, '')}
                                                                    </p>
                                                                </div>
                                                            )}

                                                            {rec.recommendation.note.includes('⚠️') && (
                                                                <div className="bg-red-500/5 border border-red-500/20 p-4 rounded-xl">
                                                                    <h4 className="text-xs font-bold text-red-400 uppercase mb-2 flex items-center gap-2">
                                                                        <AlertCircle size={14} />
                                                                        Risks & Drawbacks
                                                                    </h4>
                                                                    <p className="text-sm text-gray-300 leading-relaxed">
                                                                        {rec.recommendation.note.split('⚠️ Cons:')[1]?.trim() || ''}
                                                                    </p>
                                                                </div>
                                                            )}
                                                        </div>
                                                    )}
                                                    {!isSpread(rec) && (rec as SingleLegRecommendation).recommendation?.note && (
                                                        <div className="mb-6">
                                                            <div className="bg-green-500/5 border border-green-500/20 p-4 rounded-xl">
                                                                <h4 className="text-xs font-bold text-green-400 uppercase mb-2 flex items-center gap-2">
                                                                    <TrendingUp size={14} />
                                                                    Why This Option Is a Good Choice
                                                                </h4>
                                                                <p className="text-sm text-gray-300 leading-relaxed">
                                                                    {(rec as SingleLegRecommendation).recommendation!.note!.replace(/^✅\s*/, '').trim()}
                                                                </p>
                                                            </div>
                                                        </div>
                                                    )}
                                                    {isSpread(rec) ? (
                                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                                            <div>
                                                                <h4 className="text-xs font-bold text-gray-500 uppercase mb-4">Payoff at Expiration</h4>
                                                                <PayoffDiagram
                                                                    recommendation={rec}
                                                                    currentPrice={result.context.currentPrice}
                                                                    isCredit={rec.type.includes('Credit')}
                                                                />
                                                            </div>
                                                            <div className="space-y-4">
                                                                <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">Leg Details</h4>

                                                                {/* Legs Logic (Handle Credit vs Debit leg ordering) */}
                                                                {/* Generally Short is Sell, Long is Buy */}
                                                                {rec.shortLeg && (
                                                                    <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                                                                        <div className="flex justify-between items-center mb-1">
                                                                            <span className="text-red-400 font-bold text-xs uppercase">Short (Sell)</span>
                                                                            <span className="font-mono text-white">${rec.shortLeg.strike}</span>
                                                                        </div>
                                                                        <div className="flex justify-between text-xs text-gray-400 mb-1">
                                                                            <span>Δ {rec.shortLeg.delta}</span>
                                                                            <span>Price: ${rec.shortLeg.price}</span>
                                                                        </div>
                                                                        <div className="flex justify-between text-xs text-gray-500 pt-1 border-t border-white/5">
                                                                            <span>Vol: {rec.shortLeg.volume}</span>
                                                                            <span>OI: {rec.shortLeg.openInterest}</span>
                                                                        </div>
                                                                    </div>
                                                                )}

                                                                {rec.longLeg && (
                                                                    <div className="bg-green-500/5 border border-green-500/20 rounded-lg p-3">
                                                                        <div className="flex justify-between items-center mb-1">
                                                                            <span className="text-green-400 font-bold text-xs uppercase">Long (Buy)</span>
                                                                            <span className="font-mono text-white">${rec.longLeg.strike}</span>
                                                                        </div>
                                                                        <div className="flex justify-between text-xs text-gray-400 mb-1">
                                                                            <span>Δ {rec.longLeg.delta}</span>
                                                                            <span>Price: ${rec.longLeg.price}</span>
                                                                        </div>
                                                                        <div className="flex justify-between text-xs text-gray-500 pt-1 border-t border-white/5">
                                                                            <span>Vol: {rec.longLeg.volume}</span>
                                                                            <span>OI: {rec.longLeg.openInterest}</span>
                                                                        </div>
                                                                    </div>
                                                                )}

                                                                <div className="pt-2 border-t border-white/5 flex justify-between items-center">
                                                                    <span className="text-sm text-gray-400">Breakeven</span>
                                                                    <span className="text-white font-mono font-bold">${(rec.breakeven || 0).toFixed(2)}</span>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                                            {/* Delta, Gamma, Theta, Vega */}
                                                            <div className="p-3 bg-[#222] rounded-lg">
                                                                <div className="text-gray-500 text-[10px] uppercase">Delta</div>
                                                                <div className="text-white font-mono">{(rec as SingleLegRecommendation).delta?.toFixed(2)}</div>
                                                            </div>
                                                            <div className="p-3 bg-[#222] rounded-lg">
                                                                <div className="text-gray-500 text-[10px] uppercase">Gamma</div>
                                                                <div className="text-white font-mono">{(rec as SingleLegRecommendation).gamma?.toFixed(4)}</div>
                                                            </div>
                                                            <div className="p-3 bg-[#222] rounded-lg">
                                                                <div className="text-gray-500 text-[10px] uppercase">Theta</div>
                                                                <div className="text-red-400 font-mono">{(rec as SingleLegRecommendation).theta?.toFixed(4)}</div>
                                                            </div>
                                                            <div className="p-3 bg-[#222] rounded-lg">
                                                                <div className="text-gray-500 text-[10px] uppercase">Vega</div>
                                                                <div className="text-white font-mono">{(rec as SingleLegRecommendation).vega?.toFixed(4)}</div>
                                                            </div>
                                                            {/* Vol / OI / Gamma Eff */}
                                                            <div className="p-3 bg-[#222] rounded-lg col-span-2 md:col-span-4">
                                                                <div className="flex justify-between items-center">
                                                                    <div>
                                                                        <div className="text-gray-500 text-[10px] uppercase">Volume</div>
                                                                        <div className="text-white font-mono">{(rec as SingleLegRecommendation).volume}</div>
                                                                    </div>
                                                                    <div>
                                                                        <div className="text-gray-500 text-[10px] uppercase">Open Int</div>
                                                                        <div className="text-white font-mono">{(rec as SingleLegRecommendation).openInterest}</div>
                                                                    </div>
                                                                    <div>
                                                                        <div className="text-gray-500 text-[10px] uppercase">Gamma Eff</div>
                                                                        <div className="text-accent-green font-mono">{(rec as SingleLegRecommendation).dollarGamma?.toFixed(4)}</div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Action Buttons */}
                                                    <div className="mt-6 pt-4 border-t border-[#3A3A3C]">
                                                        {openPosIdx === idx ? (
                                                            /* Inline Open Position form */
                                                            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-4 space-y-3">
                                                                <div className="text-xs font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                                                                    <ShoppingCart size={14} />
                                                                    Open Position
                                                                </div>
                                                                <div className="flex flex-wrap gap-3 items-end">
                                                                    <div className="w-20">
                                                                        <label className="text-[10px] text-gray-500 uppercase block mb-1">Qty</label>
                                                                        <input
                                                                            type="number"
                                                                            min="1"
                                                                            value={openPosQty}
                                                                            onChange={(e) => setOpenPosQty(e.target.value)}
                                                                            className="w-full bg-[#000] border border-[#333] text-white rounded px-2 py-2 text-sm font-mono focus:outline-none focus:border-emerald-500"
                                                                            placeholder="1"
                                                                            autoFocus
                                                                        />
                                                                    </div>
                                                                    <div className="w-28">
                                                                        <label className="text-[10px] text-gray-500 uppercase block mb-1">Entry $</label>
                                                                        <input
                                                                            type="number"
                                                                            step="0.01"
                                                                            value={openPosPrice}
                                                                            onChange={(e) => setOpenPosPrice(e.target.value)}
                                                                            className="w-full bg-[#000] border border-[#333] text-white rounded px-2 py-2 text-sm font-mono focus:outline-none focus:border-emerald-500"
                                                                            placeholder="0.00"
                                                                        />
                                                                    </div>
                                                                    <div className="flex gap-1">
                                                                        {(['Yuchen', 'Annie'] as const).map(name => (
                                                                            <button
                                                                                key={name}
                                                                                type="button"
                                                                                onClick={() => setOpenPosOwner(name)}
                                                                                className={`px-2.5 py-2 rounded text-xs font-semibold transition-all ${openPosOwner === name
                                                                                    ? name === 'Yuchen'
                                                                                        ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40'
                                                                                        : 'bg-pink-500/20 text-pink-400 border border-pink-500/40'
                                                                                    : 'bg-[#111] text-gray-500 border border-[#333] hover:text-gray-300'
                                                                                    }`}
                                                                            >
                                                                                {name}
                                                                            </button>
                                                                        ))}
                                                                    </div>
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            handleOpenPosition(rec);
                                                                        }}
                                                                        disabled={openPosSubmitting || !openPosPrice}
                                                                        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-bold transition-all disabled:opacity-50 flex items-center gap-1.5"
                                                                    >
                                                                        {openPosSubmitting ? <RefreshCw size={14} className="animate-spin" /> : <ShoppingCart size={14} />}
                                                                        Confirm
                                                                    </button>
                                                                    <button
                                                                        onClick={(e) => { e.stopPropagation(); setOpenPosIdx(null); }}
                                                                        className="px-3 py-2 text-gray-500 hover:text-gray-300 text-sm transition-colors"
                                                                    >
                                                                        Cancel
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="flex justify-end gap-3">
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        handleAddToWatchlist(rec);
                                                                    }}
                                                                    className="flex items-center gap-2 px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-lg text-sm font-bold transition-all border border-blue-500/30 hover:border-blue-500/50"
                                                                >
                                                                    <Bookmark size={16} />
                                                                    Watchlist
                                                                </button>
                                                                {(
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            // Pre-fill qty from Kelly sizing, price from recommendation
                                                                            const sizing = getSuggestedContracts(rec, portfolioTotal, riskPct, { useKelly: true, stopOutFraction });
                                                                            setOpenPosQty(String(sizing.suggestedContracts || 1));
                                                                            const prefillPrice = isSpread(rec)
                                                                                ? ((rec as SpreadRecommendation).netCredit ?? (rec as SpreadRecommendation).netDebit ?? 0)
                                                                                : (rec as SingleLegRecommendation).price ?? 0;
                                                                            setOpenPosPrice(String(prefillPrice));
                                                                            setOpenPosIdx(idx);
                                                                        }}
                                                                        className="flex items-center gap-2 px-4 py-2 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 rounded-lg text-sm font-bold transition-all border border-emerald-500/30 hover:border-emerald-500/50"
                                                                    >
                                                                        <ShoppingCart size={16} />
                                                                        Open Position
                                                                    </button>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                };
                        return (
                            <div className="space-y-4">
                                {allRecs.length === 0 && (
                                    <div className="text-center py-10 text-gray-500">
                                        <Search size={32} className="mx-auto mb-2 opacity-20" />
                                        <p>No results found for this strategy with current filters.</p>
                                        {result.rejectionDiagnostics && (() => {
                                            const d = result.rejectionDiagnostics;
                                            const f = d.filters;
                                            const reasons: string[] = [];
                                            if (d.strategyChainSize === 0) {
                                                reasons.push(`No options within DTE ${d.dteWindow?.target ?? '?'} \u00b1${d.dteWindow?.range ?? 10} (${d.fullChainSize} options in full chain)`);
                                            }
                                            if (f) {
                                                if (f.ivBelow30 > 0) reasons.push(`${f.ivBelow30} option${f.ivBelow30 > 1 ? 's' : ''} rejected: IV < 30%`);
                                                if (f.noDeltaMatch > 0) reasons.push(`${f.noDeltaMatch} option${f.noDeltaMatch > 1 ? 's' : ''} outside delta range (0.25\u20130.45)`);
                                                if (f.noLongLeg > 0) reasons.push(`${f.noLongLeg} pair${f.noLongLeg > 1 ? 's' : ''} missing long leg at requested width`);
                                                if (f.lowOI > 0) reasons.push(`${f.lowOI} pair${f.lowOI > 1 ? 's' : ''} rejected: low open interest`);
                                                if (f.noLiquidity > 0) reasons.push(`${f.noLiquidity} pair${f.noLiquidity > 1 ? 's' : ''} rejected: no bid/ask or mid < $0.10`);
                                                if (f.lowBid > 0) reasons.push(`${f.lowBid} pair${f.lowBid > 1 ? 's' : ''} rejected: spread bid \u2264 $0.10`);
                                                if (f.wideSpread > 0) reasons.push(`${f.wideSpread} pair${f.wideSpread > 1 ? 's' : ''} rejected: bid-ask too wide (>15%)`);
                                                if (f.spreadCeiling > 0) reasons.push(`${f.spreadCeiling} pair${f.spreadCeiling > 1 ? 's' : ''} rejected: spread > 30% ceiling`);
                                                if (f.earningsGuard > 0) reasons.push(`${f.earningsGuard} pair${f.earningsGuard > 1 ? 's' : ''} rejected: earnings within 10 days`);
                                                if (f.slippageKill > 0) reasons.push(`${f.slippageKill} pair${f.slippageKill > 1 ? 's' : ''} rejected: slippage exceeds credit`);
                                                if (f.lowROI > 0) reasons.push(`${f.lowROI} pair${f.lowROI > 1 ? 's' : ''} rejected: effective ROI < 10%`);
                                            }
                                            if (reasons.length === 0) return null;
                                            return (
                                                <div className="mt-4 mx-auto max-w-md text-left bg-[#111] border border-[#2A2A2A] rounded-lg p-4">
                                                    <p className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1.5">
                                                        <AlertCircle size={14} className="text-yellow-500" />
                                                        Why no spreads matched
                                                    </p>
                                                    <ul className="text-xs text-gray-500 space-y-1">
                                                        {reasons.map((r, i) => (
                                                            <li key={i} className="flex items-start gap-1.5">
                                                                <span className="text-gray-600 mt-0.5">&bull;</span>
                                                                <span>{r}</span>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                )}

                                {spreadRecs.map((rec, idx) => renderCard(rec, idx))}

                                {singleRecs.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => setShowAdvanced(v => !v)}
                                        className="w-full flex items-center justify-between px-4 py-2.5 bg-[#111] border border-[#2A2A2A] rounded-lg hover:bg-[#1a1a1a] transition-colors text-left"
                                    >
                                        <span className="text-xs font-medium text-gray-400">
                                            Advanced — Single-leg options ({singleRecs.length})
                                        </span>
                                        <ChevronDown size={16} className={`text-gray-500 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                                    </button>
                                )}

                                {showAdvanced && singleRecs.map((rec, idx) => renderCard(rec, spreadRecs.length + idx))}
                            </div>
                        );
                    })()}
                </div>
            )}

            <DataFooter timestamp={null} />
        </div>
    );
};
