
import React, { useState } from 'react';
import { Search, Info, Plus, Activity } from 'lucide-react';
import { ScoredResult, Strategy } from '../lib/types';
import { Tooltip } from '../components/Tooltip';

interface ScannerPageProps {
    onAddToWatchlist?: (position: any) => void;
}

export const ScannerPage: React.FC<ScannerPageProps> = ({ onAddToWatchlist }) => {
    // Search State
    const [ticker, setTicker] = useState('SPY');
    const [strategy, setStrategy] = useState<Strategy>('long');
    const [dteMin, setDteMin] = useState(20);
    const [dteMax, setDteMax] = useState(60);
    const [minVolume, setMinVolume] = useState(50);
    const [deltaMin, setDeltaMin] = useState(0.20);
    const [deltaMax, setDeltaMax] = useState(0.80);
    const [direction, setDirection] = useState<'all' | 'call' | 'put'>('all');
    const [isDayTrade, setIsDayTrade] = useState(false);

    // Results State
    const [results, setResults] = useState<ScoredResult[]>([]);
    const [context, setContext] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleScan = async () => {
        if (!ticker) return;
        setLoading(true);
        setError('');
        setResults([]);
        setContext(null);

        try {
            const params = new URLSearchParams({
                ticker,
                strategy,
                dteMin: dteMin.toString(),
                dteMax: dteMax.toString(),
                minVolume: minVolume.toString(),
                minDelta: deltaMin.toString(),
                maxDelta: deltaMax.toString(),
                direction,
                dayTrade: isDayTrade.toString()
            });

            const res = await fetch(`/api/scan-options?${params}`);
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'Scan failed');

            setResults(data.results || []);
            setContext(data.context);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const getScoreColor = (score: number) => {
        if (score >= 75) return 'text-green-400';
        if (score >= 60) return 'text-yellow-400';
        if (score >= 45) return 'text-orange-400';
        return 'text-red-400';
    };

    const formatPercent = (val: number) => `${(val * 100).toFixed(1)}%`;

    return (
        <div className="fade-in space-y-6 pb-24 sm:pb-0">
            {/* Header / Input Panel */}
            <div className="bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl p-5 shadow-sm">
                <div className="flex flex-col md:flex-row gap-4 mb-4">
                    {/* Ticker */}
                    <div className="flex-1 min-w-[200px]">
                        <div className="mb-1.5">
                            <Tooltip
                                label="Ticker Symbol"
                                explanation="The underlying asset to scan options for (e.g., SPY, QQQ)."
                                className="text-xs text-gray-400 font-medium"
                            />
                        </div>
                        <div className="relative">
                            <input
                                type="text"
                                value={ticker}
                                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                                className="w-full bg-[#2C2C2E] border border-[#3A3A3C] text-white rounded-lg pl-10 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-green/50 placeholder-gray-500 font-medium"
                                placeholder="e.g. SPY"
                                onKeyDown={(e) => e.key === 'Enter' && handleScan()}
                            />
                            <Search className="absolute left-3 top-3 text-gray-400" size={18} />
                        </div>
                    </div>

                    {/* Strategy Selector */}
                    <div className="w-full md:w-48">
                        <div className="mb-1.5">
                            <Tooltip
                                label="Strategy"
                                explanation="Long: Buy options (Calls/Puts). Short: Sell options (Cash Secured Puts/Covered Calls)."
                                className="text-xs text-gray-400 font-medium"
                            />
                        </div>
                        <div className="flex bg-[#2C2C2E] rounded-lg p-1 border border-[#3A3A3C]">
                            <button
                                onClick={() => setStrategy('long')}
                                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${strategy === 'long' ? 'bg-[#3A3A3C] text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
                                    }`}
                            >
                                Long
                            </button>
                            <button
                                onClick={() => setStrategy('short')}
                                className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${strategy === 'short' ? 'bg-[#3A3A3C] text-white shadow-sm' : 'text-gray-400 hover:text-gray-200'
                                    }`}
                            >
                                Short
                            </button>
                        </div>
                    </div>

                    {/* Direction Selector */}
                    <div className="w-full md:w-48">
                        <label className="text-xs text-gray-400 font-medium mb-1.5 block flex items-center gap-1">
                            Direction
                        </label>
                        <select
                            value={direction}
                            onChange={(e) => setDirection(e.target.value as any)}
                            className="w-full bg-[#2C2C2E] border border-[#3A3A3C] text-white rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-green/50"
                        >
                            <option value="all">All</option>
                            <option value="call">Calls Only</option>
                            <option value="put">Puts Only</option>
                        </select>
                    </div>

                    {/* Day Trade Toggle */}
                    <div className="w-full md:w-auto flex items-end pb-3">
                        <button
                            onClick={() => setIsDayTrade(!isDayTrade)}
                            className={`flex items-center gap-2 px-4 py-2 rounded-lg border transition-colors ${isDayTrade
                                ? 'bg-purple-500/10 border-purple-500/30 text-purple-400'
                                : 'bg-[#2C2C2E] border-[#3A3A3C] text-gray-400 hover:bg-[#3A3A3C]'
                                }`}
                        >
                            <Activity size={16} />
                            <span className="text-sm font-medium">Day Trade</span>
                        </button>
                    </div>
                </div>

                {/* Filters */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                    <div>
                        <label className="text-xs text-gray-400 font-medium mb-1.5 block">DTE Range</label>
                        <div className="flex gap-2">
                            <input
                                type="number"
                                value={dteMin}
                                onChange={(e) => setDteMin(Number(e.target.value))}
                                className="w-full bg-[#2C2C2E] border border-[#3A3A3C] text-white rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-accent-green"
                            />
                            <span className="text-gray-500 self-center">-</span>
                            <input
                                type="number"
                                value={dteMax}
                                onChange={(e) => setDteMax(Number(e.target.value))}
                                className="w-full bg-[#2C2C2E] border border-[#3A3A3C] text-white rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-accent-green"
                            />
                        </div>
                    </div>
                    <div>
                        <label className="text-xs text-gray-400 font-medium mb-1.5 block">Delta Range</label>
                        <div className="flex gap-2">
                            <input
                                type="number"
                                step="0.05"
                                value={deltaMin}
                                onChange={(e) => setDeltaMin(Number(e.target.value))}
                                className="w-full bg-[#2C2C2E] border border-[#3A3A3C] text-white rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-accent-green"
                            />
                            <span className="text-gray-500 self-center">-</span>
                            <input
                                type="number"
                                step="0.05"
                                value={deltaMax}
                                onChange={(e) => setDeltaMax(Number(e.target.value))}
                                className="w-full bg-[#2C2C2E] border border-[#3A3A3C] text-white rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:border-accent-green"
                            />
                        </div>
                    </div>
                    <div>
                        <label className="text-xs text-gray-400 font-medium mb-1.5 block">Min Volume</label>
                        <input
                            type="number"
                            value={minVolume}
                            onChange={(e) => setMinVolume(Number(e.target.value))}
                            className="w-full bg-[#2C2C2E] border border-[#3A3A3C] text-white rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-accent-green"
                        />
                    </div>
                </div>

                <button
                    onClick={handleScan}
                    disabled={loading}
                    className="w-full bg-accent-green hover:bg-accent-green/90 text-black font-semibold py-3 rounded-lg transition-all active:scale-[0.98] shadow-[0_0_15px_rgba(208,253,62,0.2)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                    {loading ? (
                        <>
                            <div className="w-5 h-5 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                            Scanning Market...
                        </>
                    ) : (
                        <>
                            <Search size={20} />
                            Scan Options
                        </>
                    )}
                </button>

                {error && (
                    <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg text-sm flex items-center gap-2 animate-fade-in">
                        <Info size={16} />
                        {error}
                    </div>
                )}
            </div>

            {/* Context Stats */}
            {context && (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 animate-fade-in">
                    <div className="bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl p-3 flex flex-col items-center justify-center">
                        <span className="text-xs text-gray-400 uppercase tracking-wider mb-1">IV Ratio</span>
                        <div className={`text-xl font-bold ${context.ivStatus === 'contango' ? 'text-green-400' :
                            context.ivStatus === 'backwardation' ? 'text-red-400' : 'text-gray-300'
                            }`}>
                            {context.ivRatio}
                        </div>
                        <span className="text-[10px] text-gray-500 uppercase">{context.ivStatus}</span>
                    </div>
                    <div className="bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl p-3 flex flex-col items-center justify-center">
                        <span className="text-xs text-gray-400 uppercase tracking-wider mb-1">Current Price</span>
                        <div className="text-xl font-bold text-white">${context.currentPrice.toFixed(2)}</div>
                    </div>
                    <div className="bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl p-3 flex flex-col items-center justify-center">
                        <span className="text-xs text-gray-400 uppercase tracking-wider mb-1">Total Options</span>
                        <div className="text-xl font-bold text-gray-300">{context.totalOptions}</div>
                    </div>
                    <div className="bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl p-3 flex flex-col items-center justify-center">
                        <span className="text-xs text-gray-400 uppercase tracking-wider mb-1">Filtered</span>
                        <div className="text-xl font-bold text-accent-green">{context.filteredCount}</div>
                    </div>
                </div>
            )}

            {/* Results Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 animate-fade-in">
                {results.map((res, idx) => (
                    <div key={`${res.symbol}-${idx}`} className="group bg-[#1C1C1E] border border-[#2A2A2A] rounded-xl p-4 hover:border-accent-green/30 transition-all hover:shadow-[0_4px_20px_-10px_rgba(208,253,62,0.1)] relative">
                        {/* Header */}
                        <div className="flex justify-between items-start mb-3">
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className={`text-lg font-bold ${res.type === 'Call' ? 'text-green-400' : 'text-red-400'}`}>
                                        {res.strike} {res.type === 'Call' ? 'C' : 'P'}
                                    </span>
                                    <span className="text-xs font-mono text-gray-500 bg-[#2C2C2E] px-1.5 py-0.5 rounded">
                                        {res.expiration}
                                    </span>
                                </div>
                                <div className="text-xs text-gray-400 flex items-center gap-1.5 mt-0.5">
                                    <span>{res.dte} DTE</span>
                                    <span>•</span>
                                    <span>Vol: {res.liquidity.volume}</span>
                                    <span>•</span>
                                    <span>OI: {res.liquidity.openInterest}</span>
                                </div>
                            </div>
                            <div className="text-right">
                                <div className={`text-2xl font-black ${getScoreColor(res.score)}`}>
                                    {res.score}
                                </div>
                                <div className="text-[10px] text-gray-500 uppercase font-medium">OSS Score</div>
                            </div>
                        </div>

                        {/* Price & Greeks */}
                        <div className="grid grid-cols-2 gap-4 mb-4">
                            <div>
                                <div className="text-xs text-gray-400 mb-0.5">Price</div>
                                <div className="text-lg font-semibold text-white">${res.price.toFixed(2)}</div>
                                <div className="text-[10px] text-gray-500 flex gap-1 items-center">
                                    <span className="text-gray-400">IV:</span> {formatPercent(res.greeks.iv)}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-gray-400 mb-0.5">Metrics</div>
                                <div className="flex flex-col gap-0.5">
                                    <div className="flex justify-between text-xs">
                                        <span className="text-gray-500">Delta</span>
                                        <span className={Math.abs(res.greeks.delta) > 0.5 ? 'text-white font-medium' : 'text-gray-400'}>
                                            {res.greeks.delta.toFixed(3)}
                                        </span>
                                    </div>
                                    <div className="flex justify-between text-xs">
                                        <span className="text-gray-500">Theta</span>
                                        <span className="text-red-400/80">{res.greeks.theta.toFixed(3)}</span>
                                    </div>
                                    {strategy === 'long' && res.metrics.lambda && (
                                        <div className="flex justify-between text-xs">
                                            <span className="text-gray-500">Lambda</span>
                                            <span className="text-accent-green">{res.metrics.lambda.toFixed(1)}</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Add Button */}
                        <button
                            onClick={() => onAddToWatchlist?.({
                                ticker,
                                strike: res.strike,
                                type: res.type,
                                expiration: res.expiration,
                                entry_score: res.score,
                                current_score: res.score,
                                current_price: res.price
                            })}
                            className="w-full bg-[#2C2C2E] hover:bg-[#3A3A3C] text-gray-300 hover:text-white py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 group-hover:bg-accent-green group-hover:text-black"
                        >
                            <Plus size={16} />
                            Add to Watchlist
                        </button>
                    </div>
                ))}
            </div>

            {results.length === 0 && !loading && !error && (
                <div className="text-center py-20 text-gray-500">
                    <Search size={48} className="mx-auto mb-4 opacity-20" />
                    <p className="text-lg font-medium">No results found</p>
                    <p className="text-sm">Try adjusting your filters or search for a different ticker.</p>
                </div>
            )}
        </div>
    );
};
