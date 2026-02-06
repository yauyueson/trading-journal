import React from 'react';
import { Clock } from 'lucide-react';

interface DataFooterProps {
    timestamp: string | null;
}

export const DataFooter: React.FC<DataFooterProps> = ({ timestamp }) => {
    if (!timestamp) return null;

    // Convert CBOE timestamp (e.g., "2026-02-06 16:18:17") to a nicer format if needed
    // The user knows it's delayed, so we just show the raw time or formatted

    return (
        <div className="mt-8 pt-4 border-t border-border-default flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest text-text-tertiary">
            <Clock size={12} />
            <span>Market Data: {timestamp} (CBOE 15m Delayed)</span>
        </div>
    );
};
