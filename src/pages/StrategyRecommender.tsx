import React, { useState } from 'react';
import { TrendingUp, TrendingDown, Activity, Info, ChevronDown, AlertCircle, Search, Bookmark, Settings2, RefreshCw } from 'lucide-react';
import { Tooltip } from '../components/Tooltip';
import { DataFooter } from '../components/DataFooter';
import { ScoreFactorsView } from '../components/ScoreFactorsView';
import { PortfolioSettingsForm } from '../components/PortfolioSettingsForm';
import { useAppSettings } from '../context/AppSettingsContext';
import { getSuggestedContracts } from '../lib/riskSizing';
import { classifyTradeProfile } from '../lib/oss-core';
import { formatCurrency, SETUPS, STRATEGIES } from '../lib/utils';
import type {
    SpreadRecommendation,
    SingleLegRecommendation,
    Recommendation,
    StrategyResult,
    WatchlistItem,
    UnifiedCandidateType,
    StrategyCategory,
} from '../lib/types';



const PayoffDiagram: React.FC<{ recommendation: Recommendation; currentPrice: number; isCredit: boolean }> = ({ recommendation, currentPrice, isCredit }) => {
    const spread = recommendation as SpreadRecommendation;
    const [viewMode, setViewMode] = useState<'Exp' | 'T0'>('Exp');
    const [hoverPrice, setHoverPrice] = useState<number>(currentPrice);
    const [isHovered, setIsHovered] = useState(false);

    if (!spread.shortLeg || !spread.longLeg) return null;

    const width = 320;
    const height = 180;
    const padding = 20;

    const lowerStrike = Math.min(spread.shortLeg.strike, spread.longLeg.strike);
    const upperStrike = Math.max(spread.shortLeg.strike, spread.longLeg.strike);
    const range = upperStrike - lowerStrike;
    const minX = lowerStrike - range * 1.5;
    const maxX = upperStrike + range * 1.5;

    const xScale = (price: number) => padding + ((price - minX) / (maxX - minX)) * (width - 2 * padding);
    const xToPrice = (x: number) => minX + ((x - padding) / (width - 2 * padding)) * (maxX - minX);

    const maxPL = Math.max(spread.maxProfit, spread.maxRisk) || 1;
    const yScale = (pl: number) => (height / 2) - (pl / maxPL) * (height / 2 - padding * 2);

    const getExpPL = (price: number) => {
        const type = spread.type.includes('Put') ? 'Put' : 'Call';
        const shortIntrinsic = type === 'Call' ? Math.max(0, price - spread.shortLeg.strike) : Math.max(0, spread.shortLeg.strike - price);
        const longIntrinsic = type === 'Call' ? Math.max(0, price - spread.longLeg.strike) : Math.max(0, spread.longLeg.strike - price);
        return isCredit ? (spread.netCredit || 0) - (shortIntrinsic - longIntrinsic) : (longIntrinsic - shortIntrinsic) - (spread.netDebit || 0);
    };

    const getT0PL = (price: number) => {
        const dPrice = price - currentPrice;
        const netDelta = isCredit ? (spread.longLeg.delta - spread.shortLeg.delta) : (spread.longLeg.delta - spread.shortLeg.delta);
        return (netDelta * dPrice);
    };

    const getPL = (price: number) => viewMode === 'Exp' ? getExpPL(price) : (getExpPL(currentPrice) + getT0PL(price));

    const points = [];
    const step = (maxX - minX) / 50;
    for (let x = minX; x <= maxX; x += step) {
        points.push(`${xScale(x)},${yScale(getPL(x))}`);
    }
    const pathD = `M ${points.join(' L ')}`;

    return (
        <div className="flex flex-col items-center w-full max-w-[340px]">
            {/* View Mode Toggle */}
            <div className="flex bg-[#111] p-1 rounded-lg border border-[#333] mb-4 w-full">
                <button
                    onClick={() => setViewMode('Exp')}
                    className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all ${viewMode === 'Exp' ? 'bg-[#222] text-accent-green border border-accent-green/20' : 'text-gray-500 hover:text-gray-300'}`}
                >
                    AT EXPIRATION
                </button>
                <button
                    onClick={() => setViewMode('T0')}
                    className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all ${viewMode === 'T0' ? 'bg-[#222] text-blue-400 border border-blue-400/20' : 'text-gray-500 hover:text-gray-300'}`}
                >
                    T+0 (NOW)
                </button>
            </div>

            {/* SVG Graph */}
            <div className="relative w-full bg-[#0a0a0a] rounded-xl border border-[#222] p-2 mb-4 overflow-hidden shadow-inner">
                <svg
                    width="100%"
                    viewBox={`0 0 ${width} ${height}`}
                    className="overflow-visible cursor-crosshair select-none"
                    onMouseMove={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const x = ((e.clientX - rect.left) / rect.width) * width;
                        if (x >= padding && x <= width - padding) {
                            setHoverPrice(xToPrice(x));
                            setIsHovered(true);
                        }
                    }}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    {/* Grid/Zero Line */}
                    <line x1={padding} y1={height / 2} x2={width - padding} y2={height / 2} stroke="#333" strokeDasharray="4" />

                    {/* Payoff Curve */}
                    <path
                        d={pathD}
                        fill="none"
                        stroke={viewMode === 'Exp' ? (isCredit ? '#4ade80' : '#60a5fa') : '#A855F7'}
                        strokeWidth="2.5"
                        className="transition-all duration-500 ease-in-out"
                    />

                    {/* Current Price Marker */}
                    <line x1={xScale(currentPrice)} y1={padding} x2={xScale(currentPrice)} y2={height - padding} stroke="#fbbf24" strokeWidth="1" strokeDasharray="3" opacity="0.6" />
                    <text x={xScale(currentPrice)} y={height - 5} textAnchor="middle" fill="#fbbf24" fontSize="8" fontWeight="bold">NOW</text>

                    {/* Interactive Scrubber */}
                    <g opacity={isHovered ? 1 : 0.4} className="transition-opacity duration-300">
                        <line x1={xScale(hoverPrice)} y1={padding} x2={xScale(hoverPrice)} y2={height - padding} stroke="white" strokeWidth="1" strokeDasharray="2" />
                        <circle cx={xScale(hoverPrice)} cy={yScale(getPL(hoverPrice))} r="5" fill="white" className="shadow-lg" />

                        {/* Tooltip Overlay inside SVG */}
                        <rect x={xScale(hoverPrice) - 35} y={yScale(getPL(hoverPrice)) - 30} width={70} height={20} rx="4" fill="rgba(0,0,0,0.8)" stroke="#444" />
                        <text x={xScale(hoverPrice)} y={yScale(getPL(hoverPrice)) - 17} textAnchor="middle" fill="white" fontSize="9" fontWeight="bold" className="font-mono">
                            ${getPL(hoverPrice).toFixed(2)}
                        </text>
                    </g>

                    {/* Strike Labels */}
                    <text x={xScale(lowerStrike)} y={height / 2 + 15} textAnchor="middle" fill="#444" fontSize="8" fontWeight="bold">${lowerStrike}</text>
                    <text x={xScale(upperStrike)} y={height / 2 + 15} textAnchor="middle" fill="#444" fontSize="8" fontWeight="bold">${upperStrike}</text>
                </svg>
            </div>

            {/* Price Slider */}
            <div className="w-full px-2">
                <div className="flex justify-between text-[10px] text-gray-500 mb-1 font-mono uppercase tracking-wider">
                    <span>${minX.toFixed(0)}</span>
                    <span className="text-white font-bold bg-[#222] px-2 rounded tracking-normal">${hoverPrice.toFixed(2)}</span>
                    <span>${maxX.toFixed(0)}</span>
                </div>
                <input
                    type="range"
                    min={minX}
                    max={maxX}
                    step={0.01}
                    value={hoverPrice}
                    onChange={(e) => {
                        setHoverPrice(parseFloat(e.target.value));
                        setIsHovered(true);
                    }}
                    className="w-full h-1.5 bg-[#222] rounded-lg appearance-none cursor-pointer accent-accent-green"
                />
            </div>
        </div>
    );
};

interface OptionSelectorProps {
    onAddToWatchlist?: (item: WatchlistItem) => Promise<void>;
}

export const OptionSelector: React.FC<OptionSelectorProps> = ({ onAddToWatchlist }) => {
    const { settings, stopOutFraction } = useAppSettings();
    const { accountSize: portfolioTotal, riskPct } = settings.portfolio;
    const [ticker, setTicker] = useState('SPY');
    const [direction, setDirection] = useState<'BULL' | 'BEAR'>('BULL');
    const [marketState, setMarketState] = useState<string>('TRENDING');
    const [riskFlags, setRiskFlags] = useState({
        overextended: false,
        mtfConflict: false,
        lowVolume: false,
        nearEarnings: false,
        highVolatility: false,
        priceReversing: false
    });
    const [targetStrategy, setTargetStrategy] = useState('Auto-Select Strategy');
    const [setup, setSetup] = useState('Pullback Buy');
    const [techScoreTier, setTechScoreTier] = useState<{ label: string; value: number; range: string; color: string } | null>(null);
    const [targetDte, setTargetDte] = useState(30);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState<StrategyResult | null>(null);
    const [expandedCard, setExpandedCard] = useState<number | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    const [spreadWidth, setSpreadWidth] = useState(5);

    const handleAnalyze = async () => {
        if (!ticker) return;
        setLoading(true);
        setError('');
        setResult(null);
        setExpandedCard(null);

        try {
            const encodedStrategy = encodeURIComponent(targetStrategy);
            const encodedSetup = encodeURIComponent(setup);
            const flagsParams = `&overextended=${riskFlags.overextended}&mtfConflict=${riskFlags.mtfConflict}&lowVolume=${riskFlags.lowVolume}&nearEarnings=${riskFlags.nearEarnings}&highVolatility=${riskFlags.highVolatility}&priceReversing=${riskFlags.priceReversing}`;
            const url = `/api/strategy-recommend?ticker=${ticker}&direction=${direction}&targetDte=${targetDte}&spreadWidth=${spreadWidth}&targetStrategy=${encodedStrategy}&setup=${encodedSetup}${flagsParams}`;
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

    const getCategoryBadge = (category: StrategyCategory) => {
        switch (category) {
            case 'CREDIT_SPREAD': return { label: 'Credit', color: 'bg-red-500/20 text-red-400 border-red-500/30' };
            case 'DEBIT_SPREAD': return { label: 'Debit', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' };
            case 'SINGLE_LEG': return { label: 'Long', color: 'bg-purple-500/20 text-purple-400 border-purple-500/30' };
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
            marketState,
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
            setup: setup || 'Algorithm Rec',
            strategy: targetStrategy,
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
            market_state: marketState,
            trade_profile: entryTradeProfile,
            iv_rank_entry: entryIvRank,
            iv_regime_entry: entryIvRegimeEntry,
        };

        await onAddToWatchlist(item);
        setExpandedCard(null);
    };

    return (
        <div className="fade-in pb-24 sm:pb-0 font-sans">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-2xl font-bold flex items-center gap-2">
                    <Activity className="text-accent-green" />
                    Option Selector
                </h1>
                <p className="text-gray-400 text-sm mt-1">Single-strategy option selection driven by TradingView</p>
            </div>

            {/* Input Panel */}
            <div className="bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl p-6 mb-6 shadow-sm">
                <div className="flex flex-col gap-6">
                    {/* Portfolio / Risk Settings */}
                    <div className="border border-[#2A2A2A] rounded-lg overflow-hidden">
                        <button
                            type="button"
                            onClick={() => setShowSettings(!showSettings)}
                            className="w-full flex items-center justify-between px-4 py-3 bg-[#0a0a0a] hover:bg-[#111] transition-colors text-left"
                        >
                            <span className="flex items-center gap-2 text-sm font-medium text-gray-300">
                                <Settings2 size={16} className="text-accent-green" />
                                Portfolio Total / Account Size & Risk
                            </span>
                            <ChevronDown size={18} className={`text-gray-500 transition-transform ${showSettings ? 'rotate-180' : ''}`} />
                        </button>
                        {showSettings && (
                            <div className="p-4 bg-[#111] border-t border-[#2A2A2A]">
                                <PortfolioSettingsForm variant="full" />
                            </div>
                        )}
                    </div>
                    {/* Top Row: Ticker, TV Score, Setup, Strategy */}
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-end">
                        <div className="md:col-span-3">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Ticker Symbol</label>
                            <div className="relative">
                                <input
                                    type="text"
                                    value={ticker}
                                    onChange={(e) => setTicker(e.target.value.toUpperCase())}
                                    className="w-full bg-[#000] border border-[#333] text-white rounded-lg pl-10 pr-4 py-3 focus:outline-none focus:border-accent-green text-lg font-bold tracking-wide placeholder-gray-600 transition-colors"
                                    placeholder="e.g. SPY"
                                    onKeyDown={(e) => e.key === 'Enter' && handleAnalyze()}
                                />
                                <Search className="absolute left-3 top-3.5 text-gray-500" size={20} />
                            </div>
                        </div>
                        <div className="md:col-span-2">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">TV Score Tier</label>
                            <div className="grid grid-cols-3 gap-1.5 bg-[#000] p-1 rounded-lg border border-[#333]">
                                {[
                                    { label: 'S', value: 92, range: '90+', color: 'text-emerald-400 border-emerald-500/50 bg-emerald-500/20' },
                                    { label: 'A', value: 85, range: '80–89', color: 'text-green-400 border-green-500/50 bg-green-500/15' },
                                    { label: 'B', value: 75, range: '70–79', color: 'text-yellow-400 border-yellow-500/50 bg-yellow-500/15' },
                                ].map((tier) => (
                                    <button
                                        key={tier.label}
                                        type="button"
                                        onClick={() => setTechScoreTier(techScoreTier?.label === tier.label ? null : tier)}
                                        className={`py-2.5 rounded text-center transition-all border ${techScoreTier?.label === tier.label
                                            ? `${tier.color} shadow-sm`
                                            : 'text-gray-500 border-transparent hover:text-gray-300'
                                            }`}
                                    >
                                        <div className="text-xs font-black">{tier.label}</div>
                                        <div className="text-[9px] font-normal opacity-70 mt-0.5">{tier.range}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="md:col-span-3">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Setup</label>
                            <select
                                value={setup}
                                onChange={(e) => setSetup(e.target.value)}
                                className="w-full bg-[#000] border border-[#333] text-white rounded-lg px-4 py-3 focus:outline-none focus:border-accent-green appearance-none cursor-pointer text-lg font-bold tracking-wide transition-colors"
                            >
                                <option value="" disabled>Select Setup</option>
                                {SETUPS.filter(s => s !== 'Other').map(s => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                                <option value="Other">Other</option>
                            </select>
                        </div>
                        <div className="md:col-span-4">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Strategy Type</label>
                            <select
                                value={targetStrategy}
                                onChange={(e) => setTargetStrategy(e.target.value)}
                                className="w-full bg-[#000] border border-[#333] text-white rounded-lg px-4 py-3 focus:outline-none focus:border-accent-green appearance-none cursor-pointer text-lg font-bold tracking-wide transition-colors"
                            >
                                {STRATEGIES.map(s => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Pine Signal Row: Direction + Market State */}
                    <div className="border border-accent-green/20 bg-accent-green/5 rounded-lg p-4">
                        <div className="text-[10px] text-accent-green/70 font-bold uppercase tracking-wider mb-3 flex items-center gap-1.5">
                            <TrendingUp size={12} />
                            Pine Signal Inputs — copy from TradingView scanner
                        </div>
                        <div className="flex flex-col md:flex-row gap-4 items-end">
                            <div>
                                <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Direction</label>
                                <div className="grid grid-cols-2 gap-2 bg-[#000] p-1 rounded-lg border border-[#333] w-44">
                                    {(['BULL', 'BEAR'] as const).map((d) => (
                                        <button
                                            key={d}
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
                            <div className="flex-1">
                                <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">
                                    Market State
                                    <span className="ml-1.5 text-gray-600 normal-case font-normal">(from ADX + MB oscillator)</span>
                                </label>
                                <div className="grid grid-cols-4 gap-2 bg-[#000] p-1 rounded-lg border border-[#333]">
                                    {[
                                        { label: 'TRENDING', desc: 'ADX↑' },
                                        { label: 'EXPLOSIVE', desc: 'MB↑↑' },
                                        { label: 'RANGING', desc: 'ADX↓' },
                                        { label: 'REVERTING', desc: 'Fade' },
                                    ].map((opt) => (
                                        <button
                                            key={opt.label}
                                            onClick={() => setMarketState(opt.label)}
                                            className={`py-2 rounded px-1 text-xs font-bold transition-all ${marketState === opt.label
                                                ? 'bg-[#3A3A3C] text-white shadow-sm'
                                                : 'text-gray-500 hover:text-gray-300'
                                                }`}
                                        >
                                            <div className="flex flex-col items-center">
                                                <span className="text-[9px] sm:text-[10px]">{opt.label}</span>
                                                <span className="text-[8px] font-normal opacity-70">{opt.desc}</span>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Pine Risk Flags Row */}
                        <div className="mt-4 pt-4 border-t border-accent-green/20">
                            <label className="text-xs text-accent-green/70 font-bold mb-2 flex items-center gap-1.5 uppercase tracking-wider">
                                <AlertCircle size={12} className="text-yellow-500" />
                                Risk Flags (Check if indicated by Pine)
                            </label>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                {[
                                    { key: 'overextended', label: 'Overextended', icon: '⚠️' },
                                    { key: 'mtfConflict', label: 'MTF Conflict', icon: '⬆️' },
                                    { key: 'lowVolume', label: 'Low Volume', icon: '⏳' },
                                    { key: 'nearEarnings', label: 'Near Earnings', icon: '⚠️' },
                                    { key: 'highVolatility', label: 'High Volatility', icon: '🔥' },
                                    { key: 'priceReversing', label: 'Price Reversing', icon: '🔄' }
                                ].map((flag) => {
                                    const isActive = riskFlags[flag.key as keyof typeof riskFlags];
                                    return (
                                        <button
                                            key={flag.key}
                                            onClick={() => setRiskFlags(prev => ({ ...prev, [flag.key]: !prev[flag.key as keyof typeof riskFlags] }))}
                                            className={`py-2 px-3 rounded text-xs font-bold transition-all border flex items-center justify-center gap-1.5 ${isActive
                                                ? 'bg-yellow-500/20 text-yellow-500 border-yellow-500/40 shadow-sm'
                                                : 'bg-[#0a0a0a] text-gray-500 border-[#333] hover:text-gray-300 hover:border-[#444]'
                                                }`}
                                        >
                                            <span className="opacity-80">{flag.icon}</span>
                                            {flag.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    {/* Bottom Row: DTE, Spread Width & Analyze */}
                    <div className="flex flex-col md:flex-row gap-6 items-end">
                        <div className="w-full md:flex-1">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Target Expiration (DTE)</label>
                            <div className="grid grid-cols-5 gap-2 bg-[#000] p-1 rounded-lg border border-[#333]">
                                {[
                                    { label: 'Ultra', val: 7, text: '7-14d' },
                                    { label: 'Short', val: 14, text: '14-30d' },
                                    { label: 'Med', val: 30, text: '30-45d' },
                                    { label: 'Long', val: 45, text: '45-90d' },
                                    { label: 'Leaps', val: 90, text: '90d+' }
                                ].map((opt) => (
                                    <button
                                        key={opt.val}
                                        onClick={() => setTargetDte(opt.val)}
                                        className={`py-2 rounded px-2 text-xs font-bold transition-all ${targetDte === opt.val
                                            ? 'bg-[#3A3A3C] text-white shadow-sm'
                                            : 'text-gray-500 hover:text-gray-300'
                                            }`}
                                    >
                                        <div className="flex flex-col items-center">
                                            <span>{opt.label}</span>
                                            <span className="text-[10px] font-normal opacity-70">{opt.text}</span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="w-full md:w-56">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Spread Width</label>
                            <div className="grid grid-cols-4 gap-2 bg-[#000] p-1 rounded-lg border border-[#333]">
                                {[
                                    { label: '$2.5', val: 2.5 },
                                    { label: '$5', val: 5 },
                                    { label: '$10', val: 10 },
                                    { label: '$20', val: 20 }
                                ].map((opt) => (
                                    <button
                                        key={opt.val}
                                        onClick={() => setSpreadWidth(opt.val)}
                                        className={`py-2.5 rounded px-2 text-xs font-bold transition-all ${spreadWidth === opt.val
                                            ? 'bg-[#3A3A3C] text-white shadow-sm'
                                            : 'text-gray-500 hover:text-gray-300'
                                            }`}
                                    >
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="w-full md:w-auto">
                            <button
                                onClick={handleAnalyze}
                                disabled={loading || !ticker}
                                className="w-full md:w-auto bg-purple-600 hover:bg-purple-500 text-white font-bold py-3.5 px-8 rounded-lg transition-all shadow-lg shadow-purple-900/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-w-[140px]"
                            >
                                {loading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Activity size={20} />}
                                Analyze Strategy
                            </button>
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

            {/* Auto-backfill notice: shown when ticker had no IV history */}
            {result?.autoBackfillTriggered && (
                <div className="bg-blue-500/10 border border-blue-500/30 text-blue-300 p-4 rounded-xl mb-6 flex items-start gap-3 animate-pulse-slow">
                    <RefreshCw size={20} className="mt-0.5 shrink-0 text-blue-400 animate-spin" style={{ animationDuration: '2s' }} />
                    <div>
                        <div className="font-bold text-sm text-blue-300 mb-0.5">Building IV History for {result.context.ticker}…</div>
                        <div className="text-xs text-blue-400/80 leading-relaxed">
                            No historical IV data was found for this ticker. A backfill is running in the background (~30s).
                            Once complete, re-click <strong>Analyze Strategy</strong> to get accurate IV Rank &amp; Percentile.
                        </div>
                    </div>
                </div>
            )}

            {/* CBOE data source notice: 15-min delayed */}
            {result?.dataSource === 'CBOE' && (
                <div className="bg-amber-500/10 border border-amber-500/30 text-amber-300 p-3 rounded-xl mb-4 flex items-center gap-3">
                    <AlertCircle size={16} className="shrink-0 text-amber-400" />
                    <span className="text-xs font-medium">
                        <span className="font-bold text-amber-200">Data Source: CBOE</span>
                        {' '}— Options quotes are <span className="font-bold">15 minutes delayed</span>.
                        For real-time Greeks &amp; IV, set <code className="bg-black/40 px-1 rounded text-amber-300">DATA_SOURCE=POLYGON</code> in your environment.
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
                            marketState,
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
                                            <span className="text-base sm:text-lg font-normal text-gray-400 font-mono">${result.context.currentPrice.toFixed(2)}</span>
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

                                    {/* Lower half: Technical indicators (IV + Tech Score) */}
                                    <div className="border-t border-[#333] pt-4 sm:pt-5 mt-2">
                                        <div className="text-[10px] sm:text-xs text-gray-500 font-medium uppercase tracking-wider mb-3">Technical indicators</div>
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 sm:gap-6">
                                            {result.regime.ivTrend && (
                                                <div className="col-span-2 sm:col-span-4 mb-2">
                                                    <div className={`inline-flex items-center gap-1.5 text-[10px] sm:text-xs font-bold px-2 py-1 rounded border ${result.regime.ivTrend === 'rising'
                                                        ? 'bg-orange-500/10 border-orange-500/30 text-orange-400'
                                                        : result.regime.ivTrend === 'falling'
                                                            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                                                            : 'bg-gray-500/10 border-gray-500/30 text-gray-400'
                                                        }`}>
                                                        IV Trend (5d):&nbsp;
                                                        {result.regime.ivTrend === 'rising' && '📈 RISING'}
                                                        {result.regime.ivTrend === 'falling' && '📉 FALLING'}
                                                        {result.regime.ivTrend === 'flat' && '➡️ FLAT'}
                                                        {result.regime.iv5dChange != null && (
                                                            <span className="font-mono ml-1 opacity-80">({result.regime.iv5dChange > 0 ? '+' : ''}{result.regime.iv5dChange}pp)</span>
                                                        )}
                                                        {result.regime.ivTrend === 'rising' && direction !== 'BEAR' && targetStrategy.includes('Credit') && (
                                                            <span className="ml-1 text-orange-300">⚠️ selling into rising IV — consider debit or wait</span>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                            <div>
                                                <div className="text-xs sm:text-sm text-gray-400 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                    IV Rank
                                                    <Tooltip label="" explanation="IV Rank: current IV30 in 252d min–max range (0–100%). Low = IV cheap (buyers); high = IV expensive (sellers). N/A until enough history (run backfill once)." />
                                                </div>
                                                <div className={`text-xl sm:text-2xl font-mono font-bold mb-0.5 ${result.regime.ivRank != null ? (result.regime.ivRank < 0.3 ? 'text-emerald-400' : result.regime.ivRank > 0.7 ? 'text-amber-400' : 'text-white') : 'text-gray-500'}`}>
                                                    {result.regime.ivRank != null ? `${(result.regime.ivRank * 100).toFixed(0)}%` : 'N/A'}
                                                </div>
                                                <div className="text-[10px] text-gray-500 font-mono">
                                                    {result.regime.ivRankSampleDays != null && result.regime.ivRankSampleDays > 0 ? `${result.regime.ivRankSampleDays}d` : ''}
                                                    {result.regime.ivRank == null && (
                                                        <a
                                                            href={`/api/backfill-iv-history?ticker=${encodeURIComponent(result.context.ticker)}`}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-accent-green/80 hover:text-accent-green ml-1 underline"
                                                        >
                                                            回填
                                                        </a>
                                                    )}
                                                </div>
                                            </div>
                                            <div>
                                                <div className="text-xs sm:text-sm text-gray-400 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                    IV %
                                                    <Tooltip label="" explanation="IV Percentile: % of past days with IV30 below current. Low = IV cheap (buyers); high = IV expensive (sellers). N/A until enough history (run backfill once)." />
                                                </div>
                                                <div className={`text-xl sm:text-2xl font-mono font-bold mb-0.5 ${result.regime.ivPercentile != null ? (result.regime.ivPercentile < 0.3 ? 'text-emerald-400' : result.regime.ivPercentile > 0.7 ? 'text-amber-400' : 'text-white') : 'text-gray-500'}`}>
                                                    {result.regime.ivPercentile != null ? `${(result.regime.ivPercentile * 100).toFixed(0)}%` : 'N/A'}
                                                </div>
                                            </div>
                                            <div>
                                                <div className="text-xs sm:text-sm text-gray-400 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                    IV Ratio
                                                    <Tooltip label="" explanation="IV30/IV90 term structure. &lt;1 = contango (short vol friendly), &gt;1 = backwardation (long vol friendly)." />
                                                </div>
                                                <div className={`text-xl sm:text-2xl font-mono font-bold mb-0.5 ${(result.regime.ivRatio ?? 1) < 0.95 ? 'text-emerald-400' : (result.regime.ivRatio ?? 1) > 1.05 ? 'text-amber-400' : 'text-white'}`}>
                                                    {result.regime.ivRatio != null ? result.regime.ivRatio.toFixed(2) : 'N/A'}
                                                </div>
                                                <div className="text-[10px] text-gray-500 font-mono">
                                                    {result.regime.iv30 != null ? `IV30: ${result.regime.iv30}%` : ''} {result.regime.iv90 != null ? ` · IV90: ${result.regime.iv90}%` : ''}
                                                </div>
                                                {result.regime.slope != null && result.regime.slopeTier && result.regime.slopeTier !== 'flat' && (
                                                    <div className="text-[10px] text-gray-500 mt-0.5">
                                                        Slope {(result.regime.slope * 100).toFixed(1)}% · {result.regime.slopeTier.replace(/_/g, ' ')}
                                                    </div>
                                                )}
                                            </div>
                                            <div>
                                                <div className="text-xs sm:text-sm text-gray-400 font-medium uppercase tracking-wider mb-1 flex items-center gap-1">
                                                    IV / RV
                                                    <Tooltip label="" explanation="IV30 vs 20d realized vol. &gt;1 = implied expensive vs recent realized; &lt;1 = implied cheap. Drives regime (credit vs debit)." />
                                                </div>
                                                <div className={`text-xl sm:text-2xl font-mono font-bold mb-0.5 ${(result.regime.ivRvRatio ?? 1) > 1.1 ? 'text-amber-400' : (result.regime.ivRvRatio ?? 1) < 0.9 ? 'text-emerald-400' : 'text-white'}`}>
                                                    {result.regime.ivRvRatio != null ? result.regime.ivRvRatio.toFixed(2) : 'N/A'}
                                                </div>
                                                <div className="text-[10px] text-gray-500 font-mono">
                                                    {result.regime.rv30 != null ? `RV30: ${result.regime.rv30}%` : ''}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    {/* Target Recommendations */}
                    {(() => {
                        const recs = (result.strategies.TARGET_STRATEGY as Recommendation[]) || [];
                        return (
                            <div className="space-y-4">
                                {recs.length === 0 && (
                                    <div className="text-center py-10 text-gray-500">
                                        <Search size={32} className="mx-auto mb-2 opacity-20" />
                                        No results found for this strategy with current filters.
                                    </div>
                                )}

                                {recs.map((rec: Recommendation, idx: number) => {
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
                                                                    <span className="text-white font-mono font-bold">${rec.breakeven.toFixed(2)}</span>
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
                                                                        <div className="text-accent-green font-mono">{(rec as SingleLegRecommendation).gammaEff?.toFixed(4)}</div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* Action Buttons */}
                                                    <div className="mt-6 pt-4 border-t border-[#3A3A3C] flex justify-end">
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleAddToWatchlist(rec);
                                                            }}
                                                            className="flex items-center gap-2 px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 rounded-lg text-sm font-bold transition-all border border-blue-500/30 hover:border-blue-500/50"
                                                        >
                                                            <Bookmark size={16} />
                                                            Add to Watchlist
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })()}
                </div>
            )}

            <DataFooter timestamp={null} />
        </div>
    );
};
