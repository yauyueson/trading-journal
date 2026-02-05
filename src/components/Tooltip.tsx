import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

interface TooltipProps {
    label: string;
    explanation: string;
    formula?: string;
    position?: 'top' | 'bottom' | 'left' | 'right';
    className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({ label, explanation, formula, position = 'top', className }) => {
    const [isVisible, setIsVisible] = useState(false);
    const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});
    const [isMeasured, setIsMeasured] = useState(false);
    const triggerRef = useRef<HTMLDivElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);

    const updatePosition = () => {
        if (!triggerRef.current || !tooltipRef.current) return;

        const triggerRect = triggerRef.current.getBoundingClientRect();
        const tooltipRect = tooltipRef.current.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const padding = 12;

        let left = 0;
        let top = 0;

        // Calculate position based on preference
        if (position === 'top' || position === 'bottom') {
            // Center horizontally
            left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2;

            // Horizontal bounds check
            if (left < padding) {
                left = padding;
            } else if (left + tooltipRect.width > viewportWidth - padding) {
                left = viewportWidth - tooltipRect.width - padding;
            }

            // Vertical positioning
            if (position === 'top') {
                top = triggerRect.top - tooltipRect.height - 8;
                // Flip to bottom if not enough space
                if (top < padding) {
                    top = triggerRect.bottom + 8;
                }
            } else {
                top = triggerRect.bottom + 8;
                // Flip to top if not enough space
                if (top + tooltipRect.height > viewportHeight - padding) {
                    top = triggerRect.top - tooltipRect.height - 8;
                }
            }
        } else {
            // position is 'left' or 'right'
            // Center vertically
            top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2;

            // Vertical bounds check
            if (top < padding) {
                top = padding;
            } else if (top + tooltipRect.height > viewportHeight - padding) {
                top = viewportHeight - tooltipRect.height - padding;
            }

            // Horizontal positioning
            if (position === 'left') {
                left = triggerRect.left - tooltipRect.width - 8;
                // Flip to right if not enough space
                if (left < padding) {
                    left = triggerRect.right + 8;
                }
            } else {
                left = triggerRect.right + 8;
                // Flip to left if not enough space
                if (left + tooltipRect.width > viewportWidth - padding) {
                    left = triggerRect.left - tooltipRect.width - 8;
                }
            }
        }

        setTooltipStyle({
            position: 'fixed',
            left: `${left}px`,
            top: `${top}px`,
            zIndex: 9999,
        });
        setIsMeasured(true);
    };

    // Measure and position on visibility change
    useLayoutEffect(() => {
        if (isVisible && triggerRef.current && tooltipRef.current) {
            // Small delay to ensure tooltip is rendered
            requestAnimationFrame(() => {
                updatePosition();
            });
        } else {
            setIsMeasured(false);
        }
    }, [isVisible, position]);

    // Handle scroll and resize
    useEffect(() => {
        if (!isVisible) return;

        const handleScroll = () => setIsVisible(false);
        const handleResize = () => updatePosition();

        window.addEventListener('scroll', handleScroll, { passive: true });
        window.addEventListener('resize', handleResize, { passive: true });

        return () => {
            window.removeEventListener('scroll', handleScroll);
            window.removeEventListener('resize', handleResize);
        };
    }, [isVisible]);

    // Handle click outside
    useEffect(() => {
        if (!isVisible) return;

        const handleClickOutside = (event: MouseEvent | TouchEvent) => {
            if (
                triggerRef.current &&
                !triggerRef.current.contains(event.target as Node) &&
                tooltipRef.current &&
                !tooltipRef.current.contains(event.target as Node)
            ) {
                setIsVisible(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('touchstart', handleClickOutside);

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('touchstart', handleClickOutside);
        };
    }, [isVisible]);

    const handleToggle = (e: React.MouseEvent | React.TouchEvent) => {
        e.stopPropagation();
        e.preventDefault();
        setIsVisible(!isVisible);
    };

    const tooltipContent = isVisible ? createPortal(
        <div
            ref={tooltipRef}
            className={`w-72 max-w-[85vw] px-4 py-3 bg-bg-tertiary border border-white/10 rounded-xl shadow-2xl text-xs text-text-primary text-left font-normal normal-case tracking-normal leading-relaxed backdrop-blur-xl transition-opacity duration-200 ${isMeasured ? 'opacity-100' : 'opacity-0'
                }`}
            style={tooltipStyle}
        >
            <div className="font-semibold mb-1.5 text-accent-blue text-sm">{label}</div>
            <div className="text-text-secondary leading-relaxed">{explanation}</div>
            {formula && (
                <div className="mt-2 pt-2 border-t border-white/10">
                    <div className="text-[10px] uppercase tracking-wider text-text-tertiary mb-1">Formula</div>
                    <code className="text-accent-green font-mono text-xs bg-black/30 px-2 py-1 rounded block overflow-x-auto whitespace-pre-wrap break-all">
                        {formula}
                    </code>
                </div>
            )}
        </div>,
        document.body
    ) : null;

    return (
        <>
            <div
                className="relative inline-flex items-center gap-1 group"
                onMouseEnter={() => setIsVisible(true)}
                onMouseLeave={() => setIsVisible(false)}
            >
                <span className={className || "text-text-secondary text-xs font-medium"}>{label}</span>
                <div
                    ref={triggerRef}
                    className="relative cursor-help"
                    onClick={handleToggle}
                    onTouchStart={handleToggle}
                >
                    <HelpCircle
                        size={14}
                        className="text-text-tertiary hover:text-accent-blue transition-colors"
                    />
                </div>
            </div>
            {tooltipContent}
        </>
    );
};
