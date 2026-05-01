import React from 'react';
import { Clock } from 'lucide-react';

interface DataFooterProps {
    timestamp: string | null;
}

export const DataFooter: React.FC<DataFooterProps> = ({ timestamp }) => {
    if (!timestamp) return null;

    // CBOE usually provides UTC or current market time. 
    // We'll treat it as a Date and format to ET explicitly.
    try {
        const date = new Date(timestamp.includes('Z') ? timestamp : `${timestamp} UTC`);
        const formatted = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        }).format(date);

        return (
            <div className="mt-8 pt-4 border-t border-phosphor-green/15 flex items-center justify-center gap-2 text-[10px] font-mono uppercase tracking-widest text-phosphor-dim/70">
                <span>▌</span>
                <Clock size={12} />
                <span>MARKET_DATA: {formatted} ET (CBOE 15M DELAYED)</span>
            </div>
        );
    } catch (e) {
        // Fallback to raw if parsing fails
        return (
            <div className="mt-8 pt-4 border-t border-phosphor-green/15 flex items-center justify-center gap-2 text-[10px] font-mono uppercase tracking-widest text-phosphor-dim/70">
                <span>▌</span>
                <Clock size={12} />
                <span>MARKET_DATA: {timestamp} (CBOE 15M DELAYED)</span>
            </div>
        );
    }
};
