import React, { useState } from 'react';
import { HelpCircle } from 'lucide-react';

interface TooltipProps {
    label: string;
    explanation: string;
    position?: 'top' | 'bottom' | 'left' | 'right';
    className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({ label, explanation, position = 'top', className }) => {
    const [isVisible, setIsVisible] = useState(false);

    const positionClasses = {
        top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
        bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
        left: 'right-full top-1/2 -translate-y-1/2 mr-2',
        right: 'left-full top-1/2 -translate-y-1/2 ml-2'
    };

    return (
        <div
            className="relative inline-flex items-center gap-1 group"
            onMouseEnter={() => setIsVisible(true)}
            onMouseLeave={() => setIsVisible(false)}
        >
            <span className={className || "text-text-secondary text-xs font-medium"}>{label}</span>
            <div
                className="relative"
                onClick={(e) => e.stopPropagation()}
            >
                <HelpCircle
                    size={14}
                    className="text-text-tertiary hover:text-accent-blue transition-colors cursor-help"
                />
                {isVisible && (
                    <div
                        className={`absolute z-50 ${positionClasses[position]} w-64 px-3 py-2 bg-bg-tertiary border border-white/10 rounded-lg shadow-xl text-xs text-text-primary text-left font-normal normal-case tracking-normal leading-relaxed`}
                        style={{ pointerEvents: 'none' }}
                    >
                        <div className="font-semibold mb-1 text-accent-blue">{label}</div>
                        <div>{explanation}</div>
                        {/* Arrow */}
                        <div
                            className={`absolute w-2 h-2 bg-bg-tertiary border-white/10 rotate-45 ${position === 'top' ? 'bottom-[-5px] left-1/2 -translate-x-1/2 border-b border-r' :
                                position === 'bottom' ? 'top-[-5px] left-1/2 -translate-x-1/2 border-t border-l' :
                                    position === 'left' ? 'right-[-5px] top-1/2 -translate-y-1/2 border-t border-r' :
                                        'left-[-5px] top-1/2 -translate-y-1/2 border-b border-l'
                                }`}
                        />
                    </div>
                )}
            </div>
        </div>
    );
};
