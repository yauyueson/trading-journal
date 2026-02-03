import React from 'react';
import { LayoutDashboard, List, History, BarChart3 } from 'lucide-react';

interface TabNavProps {
    activeTab: string;
    setActiveTab: (tab: string) => void;
}

export const TabNav: React.FC<TabNavProps> = ({ activeTab, setActiveTab }) => {
    const tabs = [
        { id: 'portfolio', label: 'Portfolio', Icon: LayoutDashboard },
        { id: 'watchlist', label: 'Watchlist', Icon: List },
        { id: 'history', label: 'History', Icon: History },
        { id: 'stats', label: 'Stats', Icon: BarChart3 }
    ];

    return (
        <nav className="fixed bottom-0 left-0 right-0 sm:static bg-[#000000eb] sm:bg-transparent border-t border-white/10 sm:border-b sm:border-[#2A2A2A] sm:border-t-0 z-50 flex sm:mb-6 sm:gap-0 backdrop-blur-md sm:backdrop-blur-none pb-[safe-area-inset-bottom]">
            {tabs.map(tab => (
                <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex-1 sm:flex-none flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 sm:px-5 py-2 sm:py-4 min-h-[49px] sm:min-h-auto transition-colors relative
                    ${activeTab === tab.id ? 'text-accent-green sm:text-white' : 'text-[#8E8E93] sm:text-[#666666] hover:text-[#A3A3A3]'}`}
                >
                    <tab.Icon size={24} strokeWidth={1.5} className="sm:w-5 sm:h-5 sm:stroke-2" />
                    <span className="text-[10px] sm:text-base font-medium">{tab.label}</span>
                    {activeTab === tab.id && (
                        <div className="hidden sm:block absolute bottom-0 left-0 right-0 h-[2px] bg-accent-green"></div>
                    )}
                </button>
            ))}
        </nav>
    );
};
