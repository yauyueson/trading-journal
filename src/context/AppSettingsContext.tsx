// src/context/AppSettingsContext.tsx
import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { AppSettings, DEFAULT_APP_SETTINGS } from '../lib/types/settings';

const STORAGE_KEY = 'trading-journal-app-settings';

function loadFromStorage(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APP_SETTINGS;
    return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

function saveToStorage(s: AppSettings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_) {}
}

interface AppSettingsContextValue {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  isLoading: boolean;
  // Derived convenience values (same as old PortfolioSettingsContext)
  maxRiskPerTrade: number;
  stopOutFraction: number;
}

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null);

export const AppSettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<AppSettings>(loadFromStorage);
  const [isLoading, setIsLoading] = useState(true);

  // Load from Supabase on mount
  useEffect(() => {
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
    };
    setSettings(next);
    saveToStorage(next);
    await supabase
      .from('app_settings')
      .upsert({ id: 1, settings: next, updated_at: new Date().toISOString() });
  }, [settings]);

  const maxRiskPerTrade = (settings.portfolio.accountSize * settings.portfolio.riskPct) / 100;
  const stopOutFraction = settings.portfolio.stopOutPct / 100;

  return (
    <AppSettingsContext.Provider value={{ settings, updateSettings, isLoading, maxRiskPerTrade, stopOutFraction }}>
      {children}
    </AppSettingsContext.Provider>
  );
};

export function useAppSettings(): AppSettingsContextValue {
  const ctx = useContext(AppSettingsContext);
  if (!ctx) throw new Error('useAppSettings must be used within AppSettingsProvider');
  return ctx;
}
