import React, { useState, useMemo } from 'react';
import { Search, TrendingUp, TrendingDown, AlertTriangle, Loader2 } from 'lucide-react';
import { Tooltip } from '../components/Tooltip';

interface ScanResult {
    symbol: string;
    strike: number;
    type: 'Call' | 'Put';
    expiration: string;
    dte: number;
    price: number;
    score: number;
    metrics: {
        lambda?: number;
        gammaEff?: number;
        thetaBurn?: number;
        pop?: number;
        edge?: number;
        spreadPct: number;
    };
    greeks: {
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        iv: number;
    };
    liquidity: {
        volume: number;
        openInterest: number;
        bid: number;
        ask: number;
    };
}

interface ScanContext {
    ticker: string;
    currentPrice: number;
    ivRatio: number;
    iv30: number | null;
    iv90: number | null;
    ivStatus: 'contango' | 'neutral' | 'backwardation';
    strategy: string;
    totalOptions: number;
    filteredCount: number;
}

interface ScannerPageProps {
    onAddToWatchlist: (item: any) => Promise<void>;
}

type Direction = 'all' | 'call' | 'put';

export const ScannerPage: React.FC<ScannerPageProps> = ({ onAddToWatchlist }) => {
    const [ticker, setTicker] = useState('');
    const [strategy, setStrategy] = useState<'long' | 'short'>('long');
    const [direction, setDirection] = useState<Direction>('all');
    const [dteMin, setDteMin] = useState(20);
    const [dteMax, setDteMax] = useState(60);
    const [minVolume, setMinVolume] = useState(50);
    const [minDelta, setMinDelta] = useState(0.20);
    const [maxDelta, setMaxDelta] = useState(0.80);
    const [isDayTradeMode, setIsDayTradeMode] = useState(false);
    const [loading, setLoading] = useState(false);
    const [context, setContext] = useState<ScanContext | null>(null);
    const [results, setResults] = useState<ScanResult[]>([]);
    const [error, setError] = useState('');
    const [addingSymbol, setAddingSymbol] = useState<string | null>(null);
    const [expandedRow, setExpandedRow] = useState<string | null>(null);

    // Client-side filtering for direction and delta
    const filteredResults = useMemo(() => {
        return results.filter(r => {
            const absDelta = Math.abs(r.greeks.delta);
            // Direction filter
            if (direction === 'call' && r.type !== 'Call') return false;
            if (direction === 'put' && r.type !== 'Put') return false;
            // Delta filter
            if (absDelta < minDelta || absDelta > maxDelta) return false;
            return true;
        });
    }, [results, direction, minDelta, maxDelta]);

    const handleScan = async () => {
        if (!ticker.trim()) return;

        setLoading(true);
        setError('');
        setResults([]);
        setContext(null);
        setExpandedRow(null); // Reset expansion on new scan

        try {
            const params = new URLSearchParams({
                ticker: ticker.toUpperCase(),
                strategy,
                dteMin: dteMin.toString(),
                dteMax: dteMax.toString(),
                minVolume: minVolume.toString(),
                // Pass delta filter to API so scoring happens within user's desired range
                minDelta: minDelta.toString(),
                maxDelta: maxDelta.toString(),
                dayTrade: isDayTradeMode.toString(), // Explicit mode toggle
                direction
            });

            const res = await fetch(`/api/scan-options?${params}`);
            const data = await res.json();

            if (!data.success) {
                setError(data.error || 'Scan failed');
                return;
            }

            setContext(data.context);
            setResults(data.results);
        } catch (err: any) {
            setError(err.message || 'Network error');
        } finally {
            setLoading(false);
        }
    };

    const handleAddToWatchlist = async (result: ScanResult) => {
        setAddingSymbol(result.symbol);
        try {
            await onAddToWatchlist({
                ticker: ticker.toUpperCase(),
                strike: result.strike,
                type: result.type,
                expiration: result.expiration,
                setup: strategy === 'long' ? 'OSS Long' : 'OSS Short',
                entry_score: result.score,
                ideal_entry: result.price,
                notes: `λ=${result.metrics.lambda?.toFixed(1) || 'N/A'}, Δ=${result.greeks.delta.toFixed(2)}, IV=${(result.greeks.iv * 100).toFixed(0)}%`
            });
        } finally {
            setAddingSymbol(null);
        }
    };

    const toggleExpand = (symbol: string) => {
        setExpandedRow(expandedRow === symbol ? null : symbol);
    };

    const getIVStatusColor = (status: string) => {
        switch (status) {
            case 'contango': return 'text-green-400';
            case 'backwardation': return 'text-red-400';
            default: return 'text-yellow-400';
        }
    };

    const getIVStatusIcon = (status: string) => {
        switch (status) {
            case 'contango': return <TrendingDown className="inline" size={16} />;
            case 'backwardation': return <AlertTriangle className="inline" size={16} />;
            default: return <TrendingUp className="inline" size={16} />;
        }
    };

    const getScoreColor = (score: number) => {
        if (score >= 75) return 'text-green-400';
        if (score >= 60) return 'text-yellow-400';
        if (score >= 45) return 'text-orange-400';
        return 'text-red-400';
    };

    // Get option "personality" based on delta and moneyness
    const getOptionStyle = (result: ScanResult, currentPrice: number) => {
        const absDelta = Math.abs(result.greeks.delta);
        const isOTM = (result.type === 'Call' && result.strike > currentPrice) ||
            (result.type === 'Put' && result.strike < currentPrice);
        const isITM = !isOTM;

        if (absDelta < 0.15) {
            // Lottery ticket (very OTM)
            return { color: 'text-purple-400', bg: 'bg-purple-500/10', label: '🎰', tooltip: 'Lottery (< 15% win)' };
        } else if (absDelta < 0.35) {
            // Aggressive OTM
            return { color: 'text-purple-300', bg: 'bg-purple-500/5', label: '🚀', tooltip: 'Aggressive OTM' };
        } else if (absDelta <= 0.65) {
            // ATM - Balanced
            return { color: 'text-green-400', bg: 'bg-green-500/10', label: '⚖️', tooltip: 'Balanced (ATM)' };
        } else if (isITM) {
            // Deep ITM - like stock
            return { color: 'text-blue-400', bg: 'bg-blue-500/10', label: '📊', tooltip: 'Deep Value (ITM)' };
        }
        return { color: 'text-gray-400', bg: '', label: '', tooltip: '' };
    };

    // Check if low probability (lottery ticket warning)
    const isLowProbability = (delta: number) => Math.abs(delta) < 0.15;

    return (
        <div className="fade-in pb-24 sm:pb-0">
            {/* Header */}
            <div className="mb-6">
                <h2 className="text-2xl font-bold flex items-center gap-2">
                    <Search size={24} /> Options Scanner
                </h2>
                <p className="text-text-secondary text-sm">OSS v2.1 - Find high-scoring contracts</p>
            </div>

            {/* Scan Form */}
            <div className="card-elevated p-6 mb-8 border border-white/10 shadow-xl shadow-bg-primary/50 relative overflow-hidden group bg-bg-secondary/40 backdrop-blur-sm">
                {/* Glow effect */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-accent-green/5 rounded-full blur-3xl -z-10 group-hover:bg-accent-green/10 transition-colors duration-500"></div>

                {/* Grid Layout */}
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">

                    {/* Column 1: Core Selection (Ticker, Strategy, DTE) */}
                    <div className="xl:col-span-8 grid grid-cols-1 md:grid-cols-12 gap-6">
                        {/* Ticker Input */}
                        <div className="md:col-span-5 relative">
                            <label className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1.5 font-bold ml-1">Ticker Symbol</label>
                            <div className="relative group/input">
                                <input
                                    type="text"
                                    placeholder="SPY"
                                    value={ticker}
                                    onChange={e => setTicker(e.target.value.toUpperCase())}
                                    onKeyDown={e => e.key === 'Enter' && handleScan()}
                                    className="w-full px-4 py-3.5 pl-11 rounded-xl bg-bg-secondary border border-white/10 
                                             text-lg font-mono tracking-wider text-text-primary placeholder:text-text-tertiary/50
                                             focus:bg-bg-secondary focus:border-accent-green/50 focus:ring-4 focus:ring-accent-green/10 
                                             transition-all duration-200 uppercase shadow-inner"
                                />
                                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary group-focus-within/input:text-accent-green transition-colors" size={18} />
                            </div>
                        </div>

                        {/* Strategy Selection */}
                        <div className="md:col-span-3">
                            <label className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1.5 font-bold ml-1">Strategy</label>
                            <div className="flex bg-bg-secondary p-1 rounded-xl border border-white/10 h-[52px]">
                                <button
                                    onClick={() => setStrategy('long')}
                                    className={`flex-1 flex items-center justify-center gap-2 rounded-lg text-sm font-bold transition-all ${strategy === 'long'
                                        ? 'bg-accent-green/10 text-accent-green shadow-sm border border-accent-green/20'
                                        : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
                                        }`}
                                >
                                    <span>Long</span>
                                </button>
                                <button
                                    onClick={() => setStrategy('short')}
                                    className={`flex-1 flex items-center justify-center gap-2 rounded-lg text-sm font-bold transition-all ${strategy === 'short'
                                        ? 'bg-accent-red/10 text-accent-red shadow-sm border border-accent-red/20'
                                        : 'text-text-secondary hover:text-text-primary hover:bg-white/5'
                                        }`}
                                >
                                    <span>Short</span>
                                </button>
                            </div>
                        </div>

                        {/* DTE Range */}
                        <div className="md:col-span-4 relative">
                            <label className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1.5 font-bold ml-1">Expiration (DTE)</label>
                            <div className="flex items-center gap-0 w-full bg-bg-secondary rounded-xl border border-white/10 p-1 focus-within:border-accent-green/30 focus-within:ring-4 focus-within:ring-accent-green/5 transition-all h-[52px]">
                                <input
                                    type="number"
                                    value={dteMin}
                                    onChange={e => setDteMin(parseInt(e.target.value) || 0)}
                                    className="w-full bg-transparent px-3 text-center font-mono text-sm focus:outline-none text-text-primary font-medium"
                                    placeholder="Min"
                                />
                                <div className="h-4 w-px bg-white/10"></div>
                                <div className="px-3 text-[10px] text-text-tertiary font-bold">TO</div>
                                <div className="h-4 w-px bg-white/10"></div>
                                <input
                                    type="number"
                                    value={dteMax}
                                    onChange={e => setDteMax(parseInt(e.target.value) || 0)}
                                    className="w-full bg-transparent px-3 text-center font-mono text-sm focus:outline-none text-text-primary font-medium"
                                    placeholder="Max"
                                />
                            </div>
                        </div>
                    </div>

                    {/* Column 2: Filters & Actions */}
                    <div className="xl:col-span-4 flex flex-col justify-between gap-4">
                        {/* Filters Row */}
                        <div className="flex flex-wrap gap-3">
                            {/* Direction Toggle */}
                            <div className="flex bg-bg-secondary p-1 rounded-xl border border-white/10 h-[42px]">
                                <button
                                    onClick={() => setDirection('all')}
                                    className={`px-3 rounded-lg text-xs font-bold transition-all ${direction === 'all'
                                        ? 'bg-text-primary text-bg-primary shadow-sm'
                                        : 'text-text-secondary hover:text-text-primary hover:bg-white/5'}`}
                                >
                                    All
                                </button>
                                <button
                                    onClick={() => setDirection('call')}
                                    className={`px-3 rounded-lg text-xs font-bold transition-all ${direction === 'call'
                                        ? 'bg-accent-green text-bg-primary shadow-sm'
                                        : 'text-text-secondary hover:text-accent-green hover:bg-accent-green/10'}`}
                                >
                                    Calls
                                </button>
                                <button
                                    onClick={() => setDirection('put')}
                                    className={`px-3 rounded-lg text-xs font-bold transition-all ${direction === 'put'
                                        ? 'bg-accent-red text-bg-primary shadow-sm'
                                        : 'text-text-secondary hover:text-accent-red hover:bg-accent-red/10'}`}
                                >
                                    Puts
                                </button>
                            </div>

                            {/* Delta Range Shortcut */}
                            <div className="flex items-center gap-2 bg-bg-secondary px-3 rounded-xl border border-white/10 h-[42px]">
                                <span className="text-xs font-bold text-text-secondary">Δ</span>
                                <input
                                    type="number"
                                    step="0.05"
                                    value={minDelta}
                                    onChange={e => setMinDelta(parseFloat(e.target.value) || 0.20)}
                                    className="w-10 bg-transparent text-center font-mono text-xs focus:outline-none text-text-primary"
                                />
                                <span className="text-text-tertiary">-</span>
                                <input
                                    type="number"
                                    step="0.05"
                                    value={maxDelta}
                                    onChange={e => setMaxDelta(parseFloat(e.target.value) || 0.80)}
                                    className="w-10 bg-transparent text-center font-mono text-xs focus:outline-none text-text-primary"
                                />
                            </div>

                            {/* Min Vol */}
                            <div className="flex items-center gap-2 bg-bg-secondary px-3 rounded-xl border border-white/10 h-[42px]">
                                <span className="text-xs font-bold text-text-secondary">Vol</span>
                                <input
                                    type="number"
                                    value={minVolume}
                                    onChange={e => setMinVolume(parseInt(e.target.value) || 50)}
                                    className="w-12 bg-transparent text-center font-mono text-xs focus:outline-none text-text-primary"
                                />
                            </div>
                        </div>

                        {/* Actions Row */}
                        <div className="flex items-center gap-4 mt-auto">
                            <button
                                onClick={() => setIsDayTradeMode(!isDayTradeMode)}
                                className={`flex items-center gap-2 px-4 h-[48px] rounded-xl border transition-all duration-300 ${isDayTradeMode
                                    ? 'bg-purple-500/20 border-purple-500/50 text-purple-300 shadow-[0_0_15px_rgba(168,85,247,0.2)]'
                                    : 'bg-bg-secondary border-white/10 text-text-secondary hover:text-text-primary hover:border-white/20'
                                    }`}
                            >
                                <div className={`w-2 h-2 rounded-full ${isDayTradeMode ? 'bg-purple-400 animate-pulse' : 'bg-text-tertiary'}`}></div>
                                <span className="text-sm font-bold whitespace-nowrap">Day Trade</span>
                            </button>

                            <button
                                onClick={handleScan}
                                className="flex-1 flex items-center justify-center gap-2 h-[48px] bg-accent-green hover:bg-accent-green/90 text-black font-bold rounded-xl transition-all shadow-lg shadow-accent-green/25 hover:shadow-accent-green/50 hover:-translate-y-0.5 active:translate-y-0 text-base border-2 border-white/20 hover:border-white/40"
                            >
                                {loading ? <Loader2 className="animate-spin" size={20} /> : <Search size={20} />}
                                <span>{loading ? 'Scanning...' : 'Scan Market'}</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Error */}
            {
                error && (
                    <div className="card p-4 mb-6 border-red-500/50 text-red-400">
                        ❌ {error}
                    </div>
                )
            }

            {/* Context Banner */}
            {
                context && (
                    <div className="card p-4 mb-6 bg-gradient-to-r from-bg-secondary to-bg-tertiary">
                        <div className="flex flex-wrap items-center gap-6 text-sm">
                            <div>
                                <span className="text-text-secondary">Ticker:</span>{' '}
                                <span className="font-bold text-lg">{context.ticker}</span>
                                <span className="text-text-secondary ml-2">${context.currentPrice.toFixed(2)}</span>
                            </div>
                            <div className={getIVStatusColor(context.ivStatus)}>
                                {getIVStatusIcon(context.ivStatus)}{' '}
                                <span className="font-mono">IV Ratio: {context.ivRatio.toFixed(3)}</span>
                                <span className="ml-1 capitalize">({context.ivStatus})</span>
                            </div>
                            {context.iv30 && context.iv90 && (
                                <div className="text-text-secondary">
                                    IV₃₀: {(context.iv30 * 100).toFixed(1)}% | IV₉₀: {(context.iv90 * 100).toFixed(1)}%
                                </div>
                            )}
                            <div className="text-text-secondary">
                                {filteredResults.length} shown / {results.length} scored
                            </div>
                        </div>
                        {context.ivStatus === 'backwardation' && strategy === 'long' && (
                            <div className="mt-3 text-yellow-500 text-sm flex items-center gap-2">
                                <AlertTriangle size={16} />
                                IV is inverted (backwardation). Long positions carry extra risk. Consider short strategies.
                            </div>
                        )}
                    </div>
                )
            }

            {/* Results Table */}
            {
                filteredResults.length > 0 && context && (
                    <div className="card overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-bg-tertiary text-text-secondary">
                                    <tr>
                                        <th className="px-4 py-3 text-left">#</th>
                                        <th className="px-4 py-3 text-left min-w-[160px]">
                                            <Tooltip label="Contract" explanation="Ticker, Strike, Type, Expiration." position="top" />
                                        </th>
                                        <th className="px-4 py-3 text-center">
                                            <Tooltip label="Style" explanation="Trade personality based on Delta (e.g. Aggressive, Balanced)." position="top" />
                                        </th>
                                        <th className="px-4 py-3 text-right">
                                            <Tooltip label="Score" explanation="OSS Score (0-100). Higher is better quality." position="top" />
                                        </th>
                                        <th className="px-4 py-3 text-right">
                                            <Tooltip label="Price" explanation="Ask Price." position="top" />
                                        </th>
                                        <th className="px-4 py-3 text-right">
                                            <Tooltip label="Δ" explanation="Delta. Exposure to stock price movement." position="top" />
                                        </th>
                                        <th className="px-4 py-3 text-right">
                                            <Tooltip
                                                label={strategy === 'long' ? 'λ' : 'POP'}
                                                explanation={strategy === 'long' ? 'Lambda. Leverage factor.' : 'Probability of Profit.'}
                                                position="top"
                                            />
                                        </th>
                                        <th className="px-4 py-3 text-right">
                                            <Tooltip label="IV" explanation="Implied Volatility." position="top" />
                                        </th>
                                        <th className="px-4 py-3 text-right">
                                            <Tooltip label="Vol" explanation="Daily Volume." position="top" />
                                        </th>
                                        <th className="px-4 py-3 text-center">Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredResults.map((r, i) => {
                                        const style = getOptionStyle(r, context.currentPrice);
                                        const lowProb = isLowProbability(r.greeks.delta);
                                        const isExpanded = expandedRow === r.symbol;
                                        return (
                                            <React.Fragment key={r.symbol}>
                                                <tr
                                                    className={`border-t border-white/5 hover:bg-white/5 transition-colors cursor-pointer ${style.bg} ${isExpanded ? 'bg-white/10' : ''}`}
                                                    onClick={() => toggleExpand(r.symbol)}
                                                >
                                                    <td className="px-4 py-3 text-text-secondary">{i + 1}</td>
                                                    <td className="px-4 py-3">
                                                        <div className="font-mono font-medium flex items-center gap-2">
                                                            <span className={r.type === 'Call' ? 'text-green-400' : 'text-red-400'}>
                                                                ${r.strike} {r.type}
                                                            </span>
                                                            {lowProb && (
                                                                <span className="text-yellow-500" title="Low probability (<15% win rate)">
                                                                    ⚠️
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="text-text-secondary text-xs">
                                                            {r.expiration} ({r.dte}d)
                                                        </div>
                                                    </td>
                                                    <td className={`px-4 py-3 text-center ${style.color}`} title={style.tooltip}>
                                                        {style.label}
                                                    </td>
                                                    <td className={`px-4 py-3 text-right font-bold ${getScoreColor(r.score)}`}>
                                                        {r.score}
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-mono">
                                                        ${r.price.toFixed(2)}
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-mono">
                                                        {r.greeks.delta.toFixed(2)}
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-mono">
                                                        {strategy === 'long'
                                                            ? r.metrics.lambda?.toFixed(1)
                                                            : ((r.metrics.pop || 0) * 100).toFixed(0) + '%'}
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-mono">
                                                        {(r.greeks.iv * 100).toFixed(0)}%
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-mono text-text-secondary">
                                                        {r.liquidity.volume.toLocaleString()}
                                                    </td>
                                                    <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                                                        <button
                                                            onClick={() => handleAddToWatchlist(r)}
                                                            disabled={addingSymbol === r.symbol}
                                                            className="px-3 py-1 bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 cursor-pointer"
                                                        >
                                                            {addingSymbol === r.symbol ? '...' : '+ Watch'}
                                                        </button>
                                                    </td>
                                                </tr>
                                                {isExpanded && (
                                                    <tr className="border-t border-white/5 bg-bg-tertiary/50">
                                                        <td colSpan={10} className="px-6 py-4">
                                                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                                                {/* Greeks Section */}
                                                                <div className="space-y-2">
                                                                    <div className="text-sm font-semibold text-accent-blue mb-3">Greeks</div>
                                                                    <div className="flex justify-between text-sm">
                                                                        <span className="text-text-secondary">Delta (Δ)</span>
                                                                        <span className="font-mono">{r.greeks.delta.toFixed(4)}</span>
                                                                    </div>
                                                                    <div className="flex justify-between text-sm">
                                                                        <span className="text-text-secondary">Gamma (Γ)</span>
                                                                        <span className="font-mono">{r.greeks.gamma.toFixed(4)}</span>
                                                                    </div>
                                                                    <div className="flex justify-between text-sm">
                                                                        <span className="text-text-secondary">Theta (Θ)</span>
                                                                        <span className="font-mono">{r.greeks.theta.toFixed(4)}</span>
                                                                    </div>
                                                                    <div className="flex justify-between text-sm">
                                                                        <span className="text-text-secondary">Vega (ν)</span>
                                                                        <span className="font-mono">{r.greeks.vega.toFixed(4)}</span>
                                                                    </div>
                                                                </div>

                                                                {/* Metrics Section */}
                                                                <div className="space-y-2">
                                                                    <div className="text-sm font-semibold text-accent-green mb-3">Metrics</div>
                                                                    {strategy === 'long' ? (
                                                                        <>
                                                                            <div className="flex justify-between text-sm">
                                                                                <span className="text-text-secondary">Lambda (λ)</span>
                                                                                <span className="font-mono">{r.metrics.lambda?.toFixed(2)}</span>
                                                                            </div>
                                                                            <div className="flex justify-between text-sm">
                                                                                <span className="text-text-secondary">Gamma Eff</span>
                                                                                <span className="font-mono">{r.metrics.gammaEff?.toFixed(4)}</span>
                                                                            </div>
                                                                            <div className="flex justify-between text-sm">
                                                                                <span className="text-text-secondary">Theta Burn</span>
                                                                                <span className="font-mono">{r.metrics.thetaBurn?.toFixed(4)}</span>
                                                                            </div>
                                                                        </>
                                                                    ) : (
                                                                        <>
                                                                            <div className="flex justify-between text-sm">
                                                                                <span className="text-text-secondary">POP</span>
                                                                                <span className="font-mono">{((r.metrics.pop || 0) * 100).toFixed(1)}%</span>
                                                                            </div>
                                                                            <div className="flex justify-between text-sm">
                                                                                <span className="text-text-secondary">Edge</span>
                                                                                <span className="font-mono">${r.metrics.edge?.toFixed(2)}</span>
                                                                            </div>
                                                                        </>
                                                                    )}
                                                                    <div className="flex justify-between text-sm">
                                                                        <span className="text-text-secondary">Spread</span>
                                                                        <span className="font-mono">{(r.metrics.spreadPct * 100).toFixed(1)}%</span>
                                                                    </div>
                                                                </div>

                                                                {/* Liquidity Section */}
                                                                <div className="space-y-2">
                                                                    <div className="text-sm font-semibold text-accent-yellow mb-3">Liquidity</div>
                                                                    <div className="flex justify-between text-sm">
                                                                        <span className="text-text-secondary">Bid</span>
                                                                        <span className="font-mono">${r.liquidity.bid.toFixed(2)}</span>
                                                                    </div>
                                                                    <div className="flex justify-between text-sm">
                                                                        <span className="text-text-secondary">Ask</span>
                                                                        <span className="font-mono">${r.liquidity.ask.toFixed(2)}</span>
                                                                    </div>
                                                                    <div className="flex justify-between text-sm">
                                                                        <span className="text-text-secondary">Volume</span>
                                                                        <span className="font-mono">{r.liquidity.volume.toLocaleString()}</span>
                                                                    </div>
                                                                    <div className="flex justify-between text-sm">
                                                                        <span className="text-text-secondary">Open Interest</span>
                                                                        <span className="font-mono">{r.liquidity.openInterest.toLocaleString()}</span>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </td>
                                                    </tr>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}

                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

            {/* Empty State */}
            {!loading && filteredResults.length === 0 && context && (
                <div className="text-center py-16 text-text-secondary">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-tertiary flex items-center justify-center">
                        <Search size={32} strokeWidth={1.5} />
                    </div>
                    <p>No contracts matched your filters</p>
                    <p className="text-sm mt-1">Try adjusting Delta range or direction filter</p>
                </div>
            )}

            {/* Initial State */}
            {!loading && !context && results.length === 0 && !error && (
                <div className="text-center py-16 text-text-secondary">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-bg-tertiary flex items-center justify-center">
                        <Search size={32} strokeWidth={1.5} />
                    </div>
                    <p>Enter a ticker and click Scan</p>
                    <p className="text-sm mt-1">Find options with the highest mathematical edge</p>
                </div>
            )}

            {/* Legend */}
            <div className="px-4 py-3 bg-bg-tertiary border-t border-white/5 text-xs text-text-secondary flex flex-wrap gap-4">
                <span><span className="text-purple-400">🎰</span> Lottery (&lt;15%)</span>
                <span><span className="text-purple-300">🚀</span> Aggressive OTM</span>
                <span><span className="text-green-400">⚖️</span> Balanced ATM</span>
                <span><span className="text-blue-400">📊</span> Deep ITM</span>
                <span><span className="text-yellow-500">⚠️</span> Low probability</span>
            </div>
        </div>
    );
}



