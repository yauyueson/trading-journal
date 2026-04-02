import React, { useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { LayoutDashboard, Gauge, History, BarChart3, Target, BookOpen, FlaskConical, Radio } from 'lucide-react';
import { PATH_TO_TAB, TAB_PATHS } from '../router';

interface TabNavProps {
    activeTab?: string;
    setActiveTab?: (tab: string) => void;
}

export const TabNav: React.FC<TabNavProps> = ({ activeTab: activeTabProp, setActiveTab: setActiveTabProp }) => {
    const navigate = useNavigate();
    const location = useLocation();

    const activeTab = activeTabProp ?? (PATH_TO_TAB[location.pathname] || 'dashboard');
    const setActiveTab = setActiveTabProp ?? ((tab: string) => navigate(TAB_PATHS[tab] || '/dashboard'));

    const tabs = [
        { id: 'dashboard', label: 'Dashboard', mobileLabel: 'Home', Icon: Gauge },
        { id: 'signals', label: 'Signals', mobileLabel: 'Signals', Icon: Radio },
        { id: 'selector', label: 'Spread Builder', mobileLabel: 'Builder', Icon: Target },
        { id: 'portfolio', label: 'Portfolio', mobileLabel: 'Portfolio', Icon: LayoutDashboard },
        { id: 'history', label: 'History', mobileLabel: 'History', Icon: History },
        { id: 'stats', label: 'Stats', mobileLabel: 'Stats', Icon: BarChart3 },
        { id: 'academy', label: 'Academy', mobileLabel: 'Learn', Icon: BookOpen },
        { id: 'backtest', label: 'WFA', mobileLabel: 'WFA', Icon: FlaskConical }
    ];

    const scrollRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef<HTMLButtonElement>(null);

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
        <>
            {/* Desktop: inline in header — text-only, compact, Fey-style */}
            <nav className="hidden sm:flex items-center gap-1">
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        aria-label={`${tab.label} tab`}
                        aria-current={activeTab === tab.id ? 'page' : undefined}
                        className={`px-3 py-1.5 text-[13px] font-medium rounded-lg transition-colors duration-200 relative
                            ${activeTab === tab.id
                                ? 'text-text-primary'
                                : 'text-text-tertiary hover:text-text-secondary'
                            }`}
                    >
                        {activeTab === tab.id && (
                            <motion.div
                                layoutId="activeTab"
                                className="absolute inset-0 bg-white/[0.08] rounded-lg"
                                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                            />
                        )}
                        <span className="relative z-10">{tab.label}</span>
                    </button>
                ))}
            </nav>

            {/* Mobile: fixed bottom bar with icons */}
            <nav
                className="fixed bottom-0 left-0 right-0 sm:hidden bg-black/90 border-t border-white/[0.06] z-50 backdrop-blur-2xl"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 4px)' }}
            >
                <div
                    ref={scrollRef}
                    className="flex overflow-x-auto scrollbar-hide"
                    style={{ WebkitOverflowScrolling: 'touch' }}
                >
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            ref={activeTab === tab.id ? activeRef : null}
                            onClick={() => setActiveTab(tab.id)}
                            aria-label={`${tab.label} tab`}
                            aria-current={activeTab === tab.id ? 'page' : undefined}
                            className={`shrink-0 flex-none flex flex-col items-center justify-center gap-1 px-4 py-2.5 min-w-[64px] min-h-[56px] transition-colors relative cursor-pointer
                                ${activeTab === tab.id ? 'text-accent-green' : 'text-[#8E8E93]'}`}
                        >
                            <tab.Icon size={22} strokeWidth={1.5} />
                            <span className="text-[10px] font-medium">{tab.mobileLabel}</span>
                            {activeTab === tab.id && (
                                <div className="w-1.5 h-1.5 rounded-full bg-accent-green absolute bottom-1.5 shadow-[0_0_6px_rgba(78,190,150,0.5)]" />
                            )}
                        </button>
                    ))}
                </div>
            </nav>
        </>
    );
};
