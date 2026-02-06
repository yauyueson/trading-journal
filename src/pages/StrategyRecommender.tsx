import React, { useState } from 'react';
import { TrendingUp, TrendingDown, Activity, Info, ChevronDown, AlertCircle, Search, Bookmark } from 'lucide-react';
import { Tooltip } from '../components/Tooltip';
import { DataFooter } from '../components/DataFooter';

// Types
interface Recommendation {
    type: string;
    score: number;
    whyThis: string;
    [key: string]: any;
}

interface SpreadRecommendation extends Recommendation {
    shortLeg: { strike: number; price: number; delta: number; expiration: string; dte: number; volume: number; openInterest: number };
    longLeg: { strike: number; price: number; delta: number; expiration: string; dte: number; volume: number; openInterest: number };
    width: number;
    netCredit?: number;
    netDebit?: number;
    maxRisk: number;
    maxProfit: number;
    roi?: number;
    pop?: number; // Probability of Profit
    expectedValue?: number;
    breakeven: number;
}

interface SingleLegRecommendation extends Recommendation {
    strike: number;
    expiration: string;
    price: number;
    delta: number;
    gamma: number;
    theta: number; // Raw Theta
    vega: number;
    volume: number;
    openInterest: number;
    lambda: number;
    gammaEff: number;
    thetaBurn: number; // Normalized Theta/Price
}



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

interface StrategyRecommenderProps {
    onAddToWatchlist?: (item: any) => Promise<void>;
}

export const StrategyRecommender: React.FC<StrategyRecommenderProps> = ({ onAddToWatchlist }) => {
    const [ticker, setTicker] = useState('SPY');
    const [direction, setDirection] = useState<'BULL' | 'BEAR'>('BULL');
    const [targetDte, setTargetDte] = useState(30);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState<any>(null); // Using any temporarily for new structure
    const [expandedCard, setExpandedCard] = useState<number | null>(null);
    const [selectedTab, setSelectedTab] = useState<string>('RECOMMENDED');

    const handleAnalyze = async () => {
        if (!ticker) return;
        setLoading(true);
        setError('');
        setResult(null);
        setExpandedCard(null);

        try {
            const res = await fetch(`/api/strategy-recommend?ticker=${ticker}&direction=${direction}&targetDte=${targetDte}`);
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'Failed to fetch recommendations');
            setResult(data);
            setSelectedTab(data.recommendedStrategy); // Default to recommended
        } catch (err: any) {
            setError(err.message);
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

    const handleAddToWatchlist = async (rec: any) => {
        if (!onAddToWatchlist) return;

        const isSpreadType = isSpread(rec);

        let legs = undefined;
        if (isSpreadType) {
            const legType = rec.type.includes('Call') ? 'Call' : 'Put';
            legs = [
                {
                    side: 'short',
                    strike: rec.shortLeg.strike,
                    type: legType,
                    expiration: rec.shortLeg.expiration
                },
                {
                    side: 'long',
                    strike: rec.longLeg.strike,
                    type: legType,
                    expiration: rec.longLeg.expiration
                }
            ];
        }

        const item = {
            ticker: result.context.ticker,
            strike: isSpreadType ? rec.shortLeg.strike : rec.strike,
            type: rec.type,
            expiration: isSpreadType ? rec.shortLeg.expiration : rec.expiration,
            setup: `Strategy Rec: ${result.regime.advice.split(':')[0]}`,
            entry_score: rec.score,
            ideal_entry: isSpreadType ? rec.netCredit || rec.netDebit : rec.price,
            target_price: 0,
            stop_reason: `Algorithm Rec: ${rec.whyThis}`,
            notes: isSpreadType
                ? `EV: $${rec.expectedValue || '0'}. Width: $${rec.width}`
                : `Delta: ${rec.delta}`,
            legs: legs
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
                    Strategy Recommender
                </h1>
                <p className="text-gray-400 text-sm mt-1">Smart strategy selection based on IV regime</p>
            </div>

            {/* Input Panel */}
            <div className="bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl p-6 mb-6 shadow-sm">
                <div className="flex flex-col gap-6">
                    {/* Top Row: Ticker & Direction */}
                    <div className="flex flex-col md:flex-row gap-6 items-end">
                        <div className="flex-1 w-full">
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

                        <div className="w-full md:w-64">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Market Bias</label>
                            <div className="flex bg-[#000] p-1 rounded-lg border border-[#333]">
                                <button
                                    onClick={() => setDirection('BULL')}
                                    className={`flex-1 py-2.5 rounded-md text-sm font-bold flex items-center justify-center gap-2 transition-all ${direction === 'BULL'
                                        ? 'bg-[#1a4d2e] text-green-400 shadow-sm border border-green-500/30'
                                        : 'text-gray-500 hover:text-gray-300'
                                        }`}
                                >
                                    <TrendingUp size={16} />
                                    BULL 🐂
                                </button>
                                <button
                                    onClick={() => setDirection('BEAR')}
                                    className={`flex-1 py-2.5 rounded-md text-sm font-bold flex items-center justify-center gap-2 transition-all ${direction === 'BEAR'
                                        ? 'bg-[#4d1a1a] text-red-400 shadow-sm border border-red-500/30'
                                        : 'text-gray-500 hover:text-gray-300'
                                        }`}
                                >
                                    <TrendingDown size={16} />
                                    BEAR 🐻
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Bottom Row: DTE & Analyze */}
                    <div className="flex flex-col md:flex-row gap-6 items-end">
                        <div className="w-full md:flex-1">
                            <label className="text-xs text-gray-400 font-medium mb-1.5 block uppercase tracking-wider">Target Expiration (DTE)</label>
                            <div className="grid grid-cols-4 gap-2 bg-[#000] p-1 rounded-lg border border-[#333]">
                                {[
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

            {/* Results */}
            {result && (
                <div className="space-y-6 animate-fade-in">
                    {/* Regime Card */}
                    <div className={`border rounded-xl p-5 relative overflow-hidden ${result.regime.mode === 'CREDIT' ? 'bg-red-900/10 border-red-500/30' :
                        result.regime.mode === 'DEBIT' ? 'bg-green-900/10 border-green-500/30' :
                            'bg-[#1C1C1E] border-[#2A2A2A]'
                        }`}>
                        <div className="flex justify-between items-start relative z-10">
                            <div>
                                <h2 className="text-2xl font-black text-white flex items-center gap-3">
                                    {result.context.ticker}
                                    <span className="text-lg font-normal text-gray-400 font-mono">${result.context.currentPrice.toFixed(2)}</span>
                                    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${result.context.direction === 'BULL' ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-red-500/20 text-red-400 border-red-500/30'
                                        }`}>
                                        {result.context.direction} {result.context.direction === 'BULL' ? '🐂' : '🐻'}
                                    </span>
                                </h2>
                                <p className={`mt-2 font-medium flex items-center gap-2 ${result.regime.mode === 'CREDIT' ? 'text-red-400' :
                                    result.regime.mode === 'DEBIT' ? 'text-green-400' : 'text-gray-300'
                                    }`}>
                                    {result.regime.mode === 'CREDIT' && <TrendingDown size={18} />}
                                    {result.regime.mode === 'DEBIT' && <TrendingUp size={18} />}
                                    {result.regime.advice}
                                </p>
                            </div>
                            <div className="text-right">
                                <div className="text-sm text-gray-400 font-medium uppercase tracking-wider mb-1">IV Ratio</div>
                                <div className="text-3xl font-mono font-bold text-white mb-1">
                                    {result.regime.ivRatio.toFixed(3)}
                                    <Tooltip label="" explanation="IV30 / IV90. Ratio < 0.95 suggests Contango (Cheap short-term IV). Ratio > 1.05 suggests Backwardation (Expensive short-term IV)." />
                                </div>
                                <div className="text-[10px] text-gray-500 font-mono">
                                    IV30: {result.regime.iv30}% | IV90: {result.regime.iv90}%
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Strategy Tabs */}
                    <div className="flex border-b border-[#2A2A2A] gap-6">
                        {[
                            { id: 'CREDIT_SPREAD', label: 'Credit Spreads' },
                            { id: 'DEBIT_SPREAD', label: 'Debit Spreads' },
                            { id: 'SINGLE_LEG', label: 'Long Options' }
                        ].map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => { setSelectedTab(tab.id); setExpandedCard(null); }}
                                className={`pb-3 text-sm font-bold relative transition-colors ${selectedTab === tab.id ? 'text-white' : 'text-gray-500 hover:text-gray-300'
                                    }`}
                            >
                                {tab.label}
                                {result.recommendedStrategy === tab.id && (
                                    <span className="ml-2 bg-accent-green/20 text-accent-green text-[10px] px-1.5 py-0.5 rounded-sm border border-accent-green/30">
                                        ⭐ Recommended
                                    </span>
                                )}
                                {selectedTab === tab.id && (
                                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-green shadow-[0_0_10px_rgba(208,253,62,0.5)]" />
                                )}
                            </button>
                        ))}
                    </div>

                    {/* Recommendations List */}
                    <div className="space-y-4">
                        {result.strategies[selectedTab]?.length === 0 && (
                            <div className="text-center py-10 text-gray-500">
                                <Search size={32} className="mx-auto mb-2 opacity-20" />
                                No results found for this strategy with current filters.
                            </div>
                        )}

                        {result.strategies[selectedTab]?.map((rec: any, idx: number) => (
                            <div
                                key={idx}
                                className={`bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl overflow-hidden transition-all duration-300 ${expandedCard === idx ? 'ring-1 ring-accent-green/50 shadow-lg shadow-green-900/10' : 'hover:border-[#444]'
                                    }`}
                            >
                                {/* Card Header (Clickable) */}
                                <div
                                    className="p-5 cursor-pointer flex flex-col md:flex-row justify-between items-start md:items-center gap-4"
                                    onClick={() => setExpandedCard(expandedCard === idx ? null : idx)}
                                >
                                    <div className="flex-1">
                                        <div className="flex items-center gap-3 mb-1">
                                            <div className={`text-4xl font-black ${getScoreColor(rec.score)}`}>{rec.score}</div>
                                            <div>
                                                <div className="font-bold text-lg text-white">{isSpread(rec) ? 'Spread' : rec.type}</div>
                                                <div className="text-sm text-gray-400 font-mono">
                                                    {isSpread(rec) ? (
                                                        <span className="flex items-center gap-2">
                                                            ${rec.shortLeg?.strike} / ${rec.longLeg?.strike} • {rec.shortLeg?.expiration || rec.longLeg?.expiration}
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
                                        <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3 text-sm">
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
                                                    {(rec as SpreadRecommendation).expectedValue !== undefined && (
                                                        <div className="flex flex-col">
                                                            <span className="text-[10px] text-gray-500 uppercase font-bold">EV</span>
                                                            <span className={`font-mono font-bold ${(rec as SpreadRecommendation).expectedValue! > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                                ${(rec as SpreadRecommendation).expectedValue}
                                                            </span>
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
                                                        <span className="text-[10px] text-gray-500 uppercase font-bold">Delta</span>
                                                        <span className="text-white font-mono font-bold">{(rec as SingleLegRecommendation).delta?.toFixed(2)}</span>
                                                    </div>
                                                    <div className="flex flex-col">
                                                        <span className="text-[10px] text-gray-500 uppercase font-bold">Lambda</span>
                                                        <span className="text-accent-green font-mono font-bold">{(rec as SingleLegRecommendation).lambda?.toFixed(1)}</span>
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
                                <div className="bg-[#2C2C2E] px-5 py-2 flex items-center gap-2 border-t border-[#3A3A3C]">
                                    <Info size={14} className="text-yellow-500" />
                                    <span className="text-sm text-gray-300 italic">{rec.whyThis}</span>
                                </div>

                                {/* Expanded Details */}
                                {expandedCard === idx && (
                                    <div className="p-5 border-t border-[#3A3A3C] bg-black/20">
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
                        ))}
                    </div>
                </div>
            )}

            <DataFooter timestamp={result?.context?.cboeTimestamp} />
        </div>
    );
};
