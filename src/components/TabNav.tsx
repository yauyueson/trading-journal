import React, { useRef, useEffect } from 'react';
import { LayoutDashboard, List, History, BarChart3, Search, Target, BookOpen, Settings } from 'lucide-react';

interface TabNavProps {
    activeTab: string;
    setActiveTab: (tab: string) => void;
}

export const TabNav: React.FC<TabNavProps> = ({ activeTab, setActiveTab }) => {
    const tabs = [
        { id: 'scanner', label: 'Scan', mobileLabel: 'Scan', Icon: Search },
        { id: 'strategy', label: 'Strategy', mobileLabel: 'Strategy', Icon: Target },
        { id: 'watchlist', label: 'Watchlist', mobileLabel: 'Watch', Icon: List },
        { id: 'portfolio', label: 'Portfolio', mobileLabel: 'Portfolio', Icon: LayoutDashboard },
        { id: 'history', label: 'History', mobileLabel: 'History', Icon: History },
        { id: 'stats', label: 'Stats', mobileLabel: 'Stats', Icon: BarChart3 },
        { id: 'academy', label: 'Academy', mobileLabel: 'Learn', Icon: BookOpen },
        { id: 'settings', label: 'Settings', mobileLabel: 'Settings', Icon: Settings }
    ];

    const scrollRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef<HTMLButtonElement>(null);

    // Scroll active tab into view on mount and tab change
    useEffect(() => {
        if (activeRef.current && scrollRef.current) {
            const container = scrollRef.current;
            const el = activeRef.current;
            const elLeft = el.offsetLeft;
            const elWidth = el.offsetWidth;
            const containerWidth = container.offsetWidth;
            const scrollLeft = elLeft - containerWidth / 2 + elWidth / 2;
            container.scrollTo({ left: scrollLeft, behavior: 'smooth' });
        }
    }, [activeTab]);

    return (
        <nav
            className="fixed bottom-0 left-0 right-0 sm:static bg-[#000000eb] sm:bg-transparent border-t border-white/10 sm:border-b sm:border-[#2A2A2A] sm:border-t-0 z-50 sm:mb-6 backdrop-blur-md sm:backdrop-blur-none"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 4px)' }}
        >
            {/* Mobile: horizontally scrollable, Desktop: flex */}
            <div
                ref={scrollRef}
                className="flex sm:flex-wrap overflow-x-auto sm:overflow-x-visible scrollbar-hide"
                style={{ WebkitOverflowScrolling: 'touch' }}
            >
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        ref={activeTab === tab.id ? activeRef : null}
                        onClick={() => setActiveTab(tab.id)}
                        aria-label={`${tab.label} tab`}
                        aria-current={activeTab === tab.id ? 'page' : undefined}
                        className={`shrink-0 sm:shrink flex-none sm:flex-none flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 px-4 sm:px-5 py-2.5 sm:py-4 min-w-[64px] sm:min-w-0 min-h-[56px] sm:min-h-auto transition-colors relative cursor-pointer
                        ${activeTab === tab.id ? 'text-accent-green sm:text-white' : 'text-[#8E8E93] sm:text-[#666666] hover:text-[#A3A3A3]'}`}
                    >
                        <tab.Icon size={22} strokeWidth={1.5} className="sm:w-5 sm:h-5 sm:stroke-2" />
                        <span className="text-[10px] sm:text-base font-medium sm:hidden">{tab.mobileLabel}</span>
                        <span className="text-base font-medium hidden sm:inline">{tab.label}</span>
                        {activeTab === tab.id && (
                            <>
                                {/* Mobile: dot indicator */}
                                <div className="sm:hidden w-1 h-1 rounded-full bg-accent-green absolute bottom-1.5"></div>
                                {/* Desktop: bottom line */}
                                <div className="hidden sm:block absolute bottom-0 left-0 right-0 h-[2px] bg-accent-green"></div>
                            </>
                        )}
                    </button>
                ))}
            </div>
        </nav>
    );
};
