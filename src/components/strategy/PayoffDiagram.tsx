import React, { useState } from 'react';
import type { Recommendation, SpreadRecommendation } from '../../lib/types';

interface PayoffDiagramProps {
    recommendation: Recommendation;
    currentPrice: number;
    isCredit: boolean;
}

export const PayoffDiagram: React.FC<PayoffDiagramProps> = ({ recommendation, currentPrice, isCredit }) => {
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
    let range = upperStrike - lowerStrike;
    if (range <= 0) range = 10;
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
        const netDelta = spread.longLeg.delta - spread.shortLeg.delta;
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
        <div className="flex flex-col items-center w-full max-w-[400px]">
            {/* View Mode Toggle */}
            <div className="flex bg-bg-secondary p-1 rounded-lg border border-white/[0.1] mb-4 w-full">
                <button
                    onClick={() => setViewMode('Exp')}
                    className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all ${viewMode === 'Exp' ? 'bg-bg-tertiary text-accent-green border border-accent-green/20' : 'text-gray-500 hover:text-gray-300'}`}
                >
                    AT EXPIRATION
                </button>
                <button
                    onClick={() => setViewMode('T0')}
                    className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all ${viewMode === 'T0' ? 'bg-bg-tertiary text-blue-400 border border-blue-400/20' : 'text-gray-500 hover:text-gray-300'}`}
                >
                    T+0 (NOW)
                </button>
            </div>

            {/* SVG Graph */}
            <div className="relative w-full bg-bg-primary rounded-xl border border-bg-tertiary p-2 mb-4 overflow-hidden shadow-inner">
                <svg
                    className="w-full h-auto overflow-visible cursor-crosshair select-none"
                    viewBox={`0 0 ${width} ${height}`}
                    preserveAspectRatio="xMidYMid meet"
                    onMouseMove={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const x = ((e.clientX - rect.left) / rect.width) * width;
                        if (x >= padding && x <= width - padding) {
                            setHoverPrice(xToPrice(x));
                            setIsHovered(true);
                        }
                    }}
                    onTouchMove={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const touch = e.touches[0];
                        const x = ((touch.clientX - rect.left) / rect.width) * width;
                        if (x >= padding && x <= width - padding) {
                            setHoverPrice(xToPrice(x));
                            setIsHovered(true);
                        }
                    }}
                    onMouseLeave={() => setIsHovered(false)}
                    onTouchEnd={() => setIsHovered(false)}
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
                    <span className="text-white font-bold bg-bg-tertiary px-2 rounded tracking-normal">${hoverPrice.toFixed(2)}</span>
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
                    className="w-full h-1.5 bg-bg-tertiary rounded-lg appearance-none cursor-pointer accent-accent-green"
                />
            </div>
        </div>
    );
};
