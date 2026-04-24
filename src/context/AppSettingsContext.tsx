// src/context/AppSettingsContext.tsx
import React, { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import { supabase, supabaseReady } from '../lib/supabase';
import { AppSettings, DEFAULT_APP_SETTINGS } from '../lib/types/settings';
import { ACTIVE_STRATEGIES, type StrategyType } from '../lib/strategyProfiles';

const STORAGE_KEY = 'trading-journal-app-settings';
const STORAGE_TS_KEY = 'trading-journal-app-settings-ts';
const STRATEGY_STORAGE_KEY = 'trading-journal-active-strategy';
const SETTINGS_FRESH_TTL = 5 * 60 * 1000; // 5 minutes

function loadFromStorage(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APP_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_APP_SETTINGS,
      ...parsed,
    };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

function isStorageFresh(): boolean {
  try {
    const ts = localStorage.getItem(STORAGE_TS_KEY);
    if (!ts) return false;
    return Date.now() - parseInt(ts, 10) < SETTINGS_FRESH_TTL;
  } catch {
    return false;
  }
}

function saveToStorage(s: AppSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    localStorage.setItem(STORAGE_TS_KEY, String(Date.now()));
  } catch (_) {}
}

interface AppSettingsContextValue {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  isLoading: boolean;
  // Derived convenience values (same as old PortfolioSettingsContext)
  maxRiskPerTrade: number;
  stopOutFraction: number;
  /** @deprecated (Phase F1 revamp): BCD + PMCC are concurrent. Prefer activeStrategies / isStrategyActive. */
  activeStrategy: StrategyType;
  /** @deprecated (Phase F1 revamp): kept for back-compat with the single-active UI. */
  setActiveStrategy: (s: StrategyType) => void;
  /** Strategies the user is currently running concurrently. Sourced from ACTIVE_STRATEGIES. */
  activeStrategies: readonly StrategyType[];
  /** True if `s` is in activeStrategies (a cheap helper for UI branching). */
  isStrategyActive: (s: StrategyType) => boolean;
}

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null);

export const AppSettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<AppSettings>(loadFromStorage);
  const [isLoading, setIsLoading] = useState(true);
  const [activeStrategy, setActiveStrategyState] = useState<StrategyType>(() => {
    try {
      const stored = localStorage.getItem(STRATEGY_STORAGE_KEY);
      const valid: StrategyType[] = ['dte5', 'swing', 'shortTerm', 'bcd', 'pmcc'];
      if (stored && valid.includes(stored as StrategyType)) return stored as StrategyType;
    } catch { /* ignore */ }
    // Default to the first active F1 strategy (BCD — small-account friendly).
    return ACTIVE_STRATEGIES[0] ?? 'bcd';
  });

  const setActiveStrategy = useCallback((s: StrategyType) => {
    setActiveStrategyState(s);
    try { localStorage.setItem(STRATEGY_STORAGE_KEY, s); } catch {}
  }, []);

  // Load from Supabase on mount — skip if localStorage has fresh data (< 5 min old)
  useEffect(() => {
    if (isStorageFresh()) {
      setIsLoading(false);
      return;
    }
    if (!supabaseReady) {
      setIsLoading(false);
      return;
    }
    supabase
      .from('app_settings')
      .select('settings')
      .eq('id', 1)
      .single()
      .then(({ data, error }) => {
        if (!error && data?.settings) {
          const merged: AppSettings = {
            ...DEFAULT_APP_SETTINGS,
            ...data.settings,
            portfolio: { ...DEFAULT_APP_SETTINGS.portfolio, ...data.settings.portfolio },
            techScore: {
              weights: { ...DEFAULT_APP_SETTINGS.techScore.weights, ...data.settings.techScore?.weights },
              periods: { ...DEFAULT_APP_SETTINGS.techScore.periods, ...data.settings.techScore?.periods },
            },
            strategy: { ...DEFAULT_APP_SETTINGS.strategy, ...data.settings.strategy },
            creditSpread: data.settings.creditSpread ? {
              dte5: { ...DEFAULT_APP_SETTINGS.creditSpread!.dte5, ...data.settings.creditSpread.dte5 },
              swing: { ...DEFAULT_APP_SETTINGS.creditSpread!.swing, ...data.settings.creditSpread.swing },
              shortTerm: { ...DEFAULT_APP_SETTINGS.creditSpread!.shortTerm, ...data.settings.creditSpread.shortTerm },
            } : DEFAULT_APP_SETTINGS.creditSpread,
          };
          setSettings(merged);
          saveToStorage(merged);
        }
        setIsLoading(false);
      });
  }, []);

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const next: AppSettings = {
      ...settings,
      ...patch,
      portfolio: { ...settings.portfolio, ...(patch.portfolio ?? {}) },
      techScore: {
        weights: { ...settings.techScore.weights, ...(patch.techScore?.weights ?? {}) },
        periods: { ...settings.techScore.periods, ...(patch.techScore?.periods ?? {}) },
      },
      strategy: { ...settings.strategy, ...(patch.strategy ?? {}) },
      creditSpread: patch.creditSpread ? {
        dte5: { ...(settings.creditSpread ?? DEFAULT_APP_SETTINGS.creditSpread!).dte5, ...patch.creditSpread.dte5 },
        swing: { ...(settings.creditSpread ?? DEFAULT_APP_SETTINGS.creditSpread!).swing, ...patch.creditSpread.swing },
        shortTerm: { ...(settings.creditSpread ?? DEFAULT_APP_SETTINGS.creditSpread!).shortTerm, ...patch.creditSpread.shortTerm },
      } : settings.creditSpread,
    };
    setSettings(next);
    saveToStorage(next);
    if (!supabaseReady) return;
    await supabase
      .from('app_settings')
      .upsert({ id: 1, settings: next, updated_at: new Date().toISOString() });
  }, [settings]);

  const maxRiskPerTrade = (settings.portfolio.accountSize * settings.portfolio.riskPct) / 100;
  const stopOutFraction = settings.portfolio.stopOutPct / 100;

  const activeStrategies = ACTIVE_STRATEGIES;
  const isStrategyActive = useCallback(
    (s: StrategyType) => activeStrategies.includes(s),
    [activeStrategies],
  );

  const value = useMemo(() => ({
    settings, updateSettings, isLoading, maxRiskPerTrade, stopOutFraction,
    activeStrategy, setActiveStrategy, activeStrategies, isStrategyActive,
  }), [settings, updateSettings, isLoading, maxRiskPerTrade, stopOutFraction,
      activeStrategy, setActiveStrategy, activeStrategies, isStrategyActive]);

  return (
    <AppSettingsContext.Provider value={value}>
      {children}
    </AppSettingsContext.Provider>
  );
};

export function useAppSettings(): AppSettingsContextValue {
  const ctx = useContext(AppSettingsContext);
  if (!ctx) throw new Error('useAppSettings must be used within AppSettingsProvider');
  return ctx;
}
