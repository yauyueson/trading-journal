import React from 'react';
import type { ScoreFactor } from '../lib/types';

interface ScoreFactorsViewProps {
    factors: ScoreFactor[];
    /** Compact single-line style for tight spaces */
    compact?: boolean;
    className?: string;
}

/**
 * Renders structured score explainability (top contributors and penalties).
 * Use in tooltips, detail drawers, or inline breakdowns.
 */
export const ScoreFactorsView: React.FC<ScoreFactorsViewProps> = ({ factors, compact = false, className = '' }) => {
    if (!factors || factors.length === 0) return null;

    if (compact) {
        return (
            <div className={`text-[10px] text-text-tertiary space-y-0.5 ${className}`}>
                {factors.slice(0, 4).map((f, i) => (
                    <div key={i} className="flex justify-between gap-2">
                        <span className="truncate">{f.name}</span>
                        <span className={f.impact >= 0 ? 'text-accent-green/90' : 'text-accent-red/90'}>
                            {f.impact >= 0 ? '+' : ''}{f.impact.toFixed(1)}
                        </span>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className={`text-xs space-y-1.5 ${className}`}>
            <div className="text-[10px] uppercase tracking-wider text-text-tertiary font-bold mb-1">Score breakdown</div>
            {factors.map((f, i) => (
                <div key={i} className="flex justify-between items-start gap-2">
                    <div className="min-w-0">
                        <span className="font-medium text-text-primary">{f.name}</span>
                        {f.value != null && (
                            <span className="ml-1 text-text-tertiary font-mono text-[10px]">({f.value})</span>
                        )}
                        <div className="text-[10px] text-text-tertiary mt-0.5">{f.description}</div>
                    </div>
                    <span className={`shrink-0 font-mono font-medium ${f.impact >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                        {f.impact >= 0 ? '+' : ''}{f.impact.toFixed(1)}
                    </span>
                </div>
            ))}
        </div>
    );
};
