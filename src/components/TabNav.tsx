import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { LayoutDashboard, Gauge, History, BarChart3, Target, BookOpen, FlaskConical, Radio } from 'lucide-react';
import { PATH_TO_TAB, TAB_PATHS } from '../router';

const tabs = [
    { id: 'dashboard', label: 'Dashboard', Icon: Gauge },
    { id: 'signals', label: 'Signals', Icon: Radio },
    { id: 'selector', label: 'Spread Builder', Icon: Target },
    { id: 'portfolio', label: 'Portfolio', Icon: LayoutDashboard },
    { id: 'history', label: 'History', Icon: History },
    { id: 'stats', label: 'Stats', Icon: BarChart3 },
    { id: 'academy', label: 'Academy', Icon: BookOpen },
    { id: 'backtest', label: 'WFA', Icon: FlaskConical },
];

export const TabNav: React.FC = () => {
    const navigate = useNavigate();
    const location = useLocation();
    const activeTab = PATH_TO_TAB[location.pathname] || 'dashboard';

    return (
        <nav className="hidden sm:flex items-center gap-1">
            {tabs.map(tab => (
                <button
                    key={tab.id}
                    onClick={() => navigate(TAB_PATHS[tab.id] || '/dashboard')}
                    aria-label={`${tab.label} tab`}
                    aria-current={activeTab === tab.id ? 'page' : undefined}
                    className={`px-3 py-1.5 font-mono uppercase tracking-wider text-[11px] transition-colors duration-200 relative cursor-pointer
                        ${activeTab === tab.id
                            ? 'text-phosphor-green text-glow-green'
                            : 'text-text-tertiary hover:text-phosphor-dim'
                        }`}
                >
                    <span className="relative z-10">{tab.label}</span>
                    {activeTab === tab.id && (
                        <motion.div
                            layoutId="activeTab"
                            className="absolute left-2 right-2 -bottom-0.5 h-0.5 bg-phosphor-green shadow-[0_0_8px_rgba(0,255,65,0.7)]"
                            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                        />
                    )}
                </button>
            ))}
        </nav>
    );
};
