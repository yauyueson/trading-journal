import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'trading-journal-portfolio-settings';
const DEFAULT_PORTFOLIO_TOTAL = 5700;
const DEFAULT_RISK_PCT = 1;
const MIN_RISK_PCT = 0.5;
const MAX_RISK_PCT = 10;
const DEFAULT_STOP_OUT_PCT = 50;
const MIN_STOP_OUT_PCT = 20;
const MAX_STOP_OUT_PCT = 80;

export interface PortfolioSettings {
    portfolioTotal: number;
    riskPct: number;
    /** Stop out at this % of max loss (e.g. 50 = exit when down 50% of max loss). */
    stopOutPct: number;
}

interface PortfolioSettingsContextValue extends PortfolioSettings {
    setPortfolioTotal: (value: number) => void;
    setRiskPct: (value: number) => void;
    setStopOutPct: (value: number) => void;
    maxRiskPerTrade: number;
    /** 0–1, for risk sizing math */
    stopOutFraction: number;
}

const defaults: PortfolioSettingsContextValue = {
    portfolioTotal: DEFAULT_PORTFOLIO_TOTAL,
    riskPct: DEFAULT_RISK_PCT,
    stopOutPct: DEFAULT_STOP_OUT_PCT,
    setPortfolioTotal: () => {},
    setRiskPct: () => {},
    setStopOutPct: () => {},
    maxRiskPerTrade: (DEFAULT_PORTFOLIO_TOTAL * DEFAULT_RISK_PCT) / 100,
    stopOutFraction: DEFAULT_STOP_OUT_PCT / 100,
};

const PortfolioSettingsContext = createContext<PortfolioSettingsContextValue>(defaults);

function loadSaved(): PortfolioSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { portfolioTotal: DEFAULT_PORTFOLIO_TOTAL, riskPct: DEFAULT_RISK_PCT, stopOutPct: DEFAULT_STOP_OUT_PCT };
        const parsed = JSON.parse(raw) as Partial<PortfolioSettings>;
        return {
            portfolioTotal: typeof parsed.portfolioTotal === 'number' && parsed.portfolioTotal > 0
                ? parsed.portfolioTotal
                : DEFAULT_PORTFOLIO_TOTAL,
            riskPct: typeof parsed.riskPct === 'number' && parsed.riskPct >= MIN_RISK_PCT && parsed.riskPct <= MAX_RISK_PCT
                ? parsed.riskPct
                : DEFAULT_RISK_PCT,
            stopOutPct: typeof parsed.stopOutPct === 'number' && parsed.stopOutPct >= MIN_STOP_OUT_PCT && parsed.stopOutPct <= MAX_STOP_OUT_PCT
                ? parsed.stopOutPct
                : DEFAULT_STOP_OUT_PCT,
        };
    } catch {
        return { portfolioTotal: DEFAULT_PORTFOLIO_TOTAL, riskPct: DEFAULT_RISK_PCT, stopOutPct: DEFAULT_STOP_OUT_PCT };
    }
}

function save(settings: PortfolioSettings) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (_) {}
}

export const PortfolioSettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [settings, setSettings] = useState<PortfolioSettings>(loadSaved);

    useEffect(() => {
        save(settings);
    }, [settings]);

    const setPortfolioTotal = useCallback((value: number) => {
        setSettings(prev => ({ ...prev, portfolioTotal: Math.max(0, value) }));
    }, []);

    const setRiskPct = useCallback((value: number) => {
        setSettings(prev => ({ ...prev, riskPct: Math.max(MIN_RISK_PCT, Math.min(MAX_RISK_PCT, value)) }));
    }, []);

    const setStopOutPct = useCallback((value: number) => {
        setSettings(prev => ({ ...prev, stopOutPct: Math.max(MIN_STOP_OUT_PCT, Math.min(MAX_STOP_OUT_PCT, value)) }));
    }, []);

    const maxRiskPerTrade = (settings.portfolioTotal * settings.riskPct) / 100;
    const stopOutFraction = settings.stopOutPct / 100;

    const value: PortfolioSettingsContextValue = {
        ...settings,
        setPortfolioTotal,
        setRiskPct,
        setStopOutPct,
        maxRiskPerTrade,
        stopOutFraction,
    };

    return (
        <PortfolioSettingsContext.Provider value={value}>
            {children}
        </PortfolioSettingsContext.Provider>
    );
};

export function usePortfolioSettings(): PortfolioSettingsContextValue {
    const ctx = useContext(PortfolioSettingsContext);
    if (!ctx) throw new Error('usePortfolioSettings must be used within PortfolioSettingsProvider');
    return ctx;
}

export { MIN_RISK_PCT, MAX_RISK_PCT, DEFAULT_PORTFOLIO_TOTAL, DEFAULT_RISK_PCT, MIN_STOP_OUT_PCT, MAX_STOP_OUT_PCT, DEFAULT_STOP_OUT_PCT };
