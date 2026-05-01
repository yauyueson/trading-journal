import React, { useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Gauge, History, BarChart3, Target, BookOpen, FlaskConical, Radio } from 'lucide-react';
import { PATH_TO_TAB, TAB_PATHS } from '../router';

const tabs = [
    { id: 'dashboard', label: 'Home', Icon: Gauge },
    { id: 'signals', label: 'Signals', Icon: Radio },
    { id: 'selector', label: 'Builder', Icon: Target },
    { id: 'portfolio', label: 'Portfolio', Icon: LayoutDashboard },
    { id: 'history', label: 'History', Icon: History },
    { id: 'stats', label: 'Stats', Icon: BarChart3 },
    { id: 'academy', label: 'Learn', Icon: BookOpen },
    { id: 'backtest', label: 'WFA', Icon: FlaskConical },
];

export const MobileTabBar: React.FC = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const activeTab = PATH_TO_TAB[location.pathname] || 'dashboard';

    const scrollRef = useRef<HTMLDivElement>(null);
    const activeRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (activeRef.current && scrollRef.current) {
            const container = scrollRef.current;
            const el = activeRef.current;
            const scrollLeft = el.offsetLeft - container.offsetWidth / 2 + el.offsetWidth / 2;
            container.scrollTo({ left: scrollLeft, behavior: 'smooth' });
        }
    }, [activeTab]);

    return (
        <nav className="fixed bottom-0 left-0 right-0 sm:hidden z-50 bg-terminal-black/95 border-t border-phosphor-green/20 backdrop-blur-xl pb-safe-nav">
            <div
                ref={scrollRef}
                className="flex overflow-x-auto scrollbar-hide"
                style={{ WebkitOverflowScrolling: 'touch', overscrollBehaviorX: 'contain' }}
            >
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        ref={activeTab === tab.id ? activeRef : null}
                        onClick={() => navigate(TAB_PATHS[tab.id] || '/dashboard')}
                        aria-label={`${tab.label} tab`}
                        aria-current={activeTab === tab.id ? 'page' : undefined}
                        className={`shrink-0 flex-none flex flex-col items-center justify-center gap-1 px-4 py-2.5 min-w-[64px] min-h-[56px] transition-all relative cursor-pointer active:scale-95
                            ${activeTab === tab.id ? 'text-phosphor-green text-glow-green' : 'text-text-tertiary'}`}
                    >
                        <tab.Icon size={22} strokeWidth={1.5} />
                        <span className="text-[10px] font-mono uppercase tracking-wider">{tab.label}</span>
                        {activeTab === tab.id && (
                            <div className="w-1.5 h-1.5 rounded-full bg-phosphor-green absolute bottom-1.5 shadow-[0_0_8px_rgba(0,255,65,0.7)]" />
                        )}
                    </button>
                ))}
            </div>
        </nav>
    );
};
