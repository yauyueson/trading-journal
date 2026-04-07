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
    );
};
