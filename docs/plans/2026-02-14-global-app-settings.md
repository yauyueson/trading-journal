# Global App Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hardcoded defaults and localStorage-only portfolio settings with a unified `AppSettingsContext` backed by a Supabase singleton row, so every calculation (frontend + API) reads live user-configured values.

**Architecture:** A single `app_settings` table holds one JSONB row (id=1) with all settings. A new `AppSettingsContext` replaces `PortfolioSettingsContext`, fetching from Supabase on mount and caching in localStorage. API handlers fetch the same row before running Tech Score calculations. A new `AppSettings` tab exposes all settings in one place.

**Tech Stack:** React 18 + TypeScript, Supabase JS v2, Vite, Tailwind CSS, Vercel Serverless Functions (ESM)

---

## Task 1: Create Supabase `app_settings` table

**Files:**
- Create: `docs/migrations/005_app_settings.sql`

**Step 1: Write the migration SQL**

```sql
-- docs/migrations/005_app_settings.sql
CREATE TABLE IF NOT EXISTS app_settings (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  settings   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforce exactly one row
CREATE UNIQUE INDEX IF NOT EXISTS app_settings_singleton ON app_settings ((true));

-- Seed with defaults matching current hardcoded values
INSERT INTO app_settings (id, settings)
VALUES (1, '{
  "portfolio": {
    "accountSize": 5700,
    "riskPct": 1,
    "stopOutPct": 50
  },
  "techScore": {
    "weights": {
      "w_mb": 30,
      "w_bxs": 30,
      "w_bxl": 15,
      "w_ema": 15,
      "w_mom": 10
    },
    "periods": {
      "sc_mb_len": 20,
      "sc_mb_smoothing": 7,
      "sc_osc_len": 7,
      "sc_bx_s1": 5,
      "sc_bx_s2": 20,
      "sc_bx_s3": 5,
      "sc_bx_l1": 20,
      "sc_bx_l2": 5
    }
  }
}'::jsonb)
ON CONFLICT (id) DO NOTHING;
```

**Step 2: Run the migration in Supabase**

Go to the Supabase dashboard → SQL Editor → paste and run `005_app_settings.sql`.

Verify: `SELECT * FROM app_settings;` returns one row with id=1.

**Step 3: Commit**

```bash
git add docs/migrations/005_app_settings.sql
git commit -m "feat: add app_settings singleton table migration"
```

---

## Task 2: Define shared TypeScript types

**Files:**
- Create: `src/lib/types/settings.ts`

**Step 1: Write the types file**

```typescript
// src/lib/types/settings.ts

export interface PortfolioSettings {
  accountSize: number;
  riskPct: number;
  /** Exit when loss reaches this % of max loss (e.g. 50 = stop at 50% of max loss) */
  stopOutPct: number;
}

export interface TechScoreWeights {
  w_mb: number;
  w_bxs: number;
  w_bxl: number;
  w_ema: number;
  w_mom: number;
}

export interface TechScorePeriods {
  sc_mb_len: number;
  sc_mb_smoothing: number;
  sc_osc_len: number;
  sc_bx_s1: number;
  sc_bx_s2: number;
  sc_bx_s3: number;
  sc_bx_l1: number;
  sc_bx_l2: number;
}

export interface TechScoreSettings {
  weights: TechScoreWeights;
  periods: TechScorePeriods;
}

export interface AppSettings {
  portfolio: PortfolioSettings;
  techScore: TechScoreSettings;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  portfolio: {
    accountSize: 5700,
    riskPct: 1,
    stopOutPct: 50,
  },
  techScore: {
    weights: { w_mb: 30, w_bxs: 30, w_bxl: 15, w_ema: 15, w_mom: 10 },
    periods: {
      sc_mb_len: 20,
      sc_mb_smoothing: 7,
      sc_osc_len: 7,
      sc_bx_s1: 5,
      sc_bx_s2: 20,
      sc_bx_s3: 5,
      sc_bx_l1: 20,
      sc_bx_l2: 5,
    },
  },
};

// Validation bounds
export const PORTFOLIO_BOUNDS = {
  MIN_RISK_PCT: 0.5,
  MAX_RISK_PCT: 10,
  MIN_STOP_OUT_PCT: 20,
  MAX_STOP_OUT_PCT: 80,
} as const;
```

**Step 2: Commit**

```bash
git add src/lib/types/settings.ts
git commit -m "feat: add shared AppSettings types and defaults"
```

---

## Task 3: Create `AppSettingsContext`

**Files:**
- Create: `src/context/AppSettingsContext.tsx`

**Step 1: Write the context**

```typescript
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
```

**Step 2: Commit**

```bash
git add src/context/AppSettingsContext.tsx
git commit -m "feat: add AppSettingsContext with Supabase persistence"
```

---

## Task 4: Wire `AppSettingsProvider` into the app and remove old provider

**Files:**
- Modify: `src/main.tsx`
- Delete: `src/context/PortfolioSettingsContext.tsx` (after all consumers migrated — do last)

**Step 1: Update `src/main.tsx`**

Replace:
```typescript
import { PortfolioSettingsProvider } from './context/PortfolioSettingsContext.tsx'
```
With:
```typescript
import { AppSettingsProvider } from './context/AppSettingsContext.tsx'
```

Replace:
```tsx
<PortfolioSettingsProvider>
    <App />
</PortfolioSettingsProvider>
```
With:
```tsx
<AppSettingsProvider>
    <App />
</AppSettingsProvider>
```

**Step 2: Commit**

```bash
git add src/main.tsx
git commit -m "feat: swap PortfolioSettingsProvider for AppSettingsProvider"
```

---

## Task 5: Migrate `src/pages/Portfolio.tsx`

**Files:**
- Modify: `src/pages/Portfolio.tsx`

**Step 1: Update imports** (line 9)

Replace:
```typescript
import { usePortfolioSettings } from '../context/PortfolioSettingsContext';
```
With:
```typescript
import { useAppSettings } from '../context/AppSettingsContext';
```

**Step 2: Update destructuring** (line 29)

Replace:
```typescript
const { portfolioTotal, riskPct, stopOutPct, stopOutFraction, maxRiskPerTrade } = usePortfolioSettings();
```
With:
```typescript
const { settings, maxRiskPerTrade, stopOutFraction } = useAppSettings();
const { accountSize: portfolioTotal, riskPct, stopOutPct } = settings.portfolio;
```

**Step 3: Commit**

```bash
git add src/pages/Portfolio.tsx
git commit -m "feat: migrate Portfolio.tsx to useAppSettings"
```

---

## Task 6: Migrate `src/pages/StrategyRecommender.tsx`

**Files:**
- Modify: `src/pages/StrategyRecommender.tsx`

**Step 1: Update imports** (line 6)

Replace:
```typescript
import { usePortfolioSettings } from '../context/PortfolioSettingsContext';
```
With:
```typescript
import { useAppSettings } from '../context/AppSettingsContext';
```

**Step 2: Update destructuring** (line 164)

Replace:
```typescript
const { portfolioTotal, riskPct, stopOutFraction, stopOutPct } = usePortfolioSettings();
```
With:
```typescript
const { settings, stopOutFraction } = useAppSettings();
const { accountSize: portfolioTotal, riskPct, stopOutPct } = settings.portfolio;
```

**Step 3: Commit**

```bash
git add src/pages/StrategyRecommender.tsx
git commit -m "feat: migrate StrategyRecommender.tsx to useAppSettings"
```

---

## Task 7: Migrate `src/components/PositionCard.tsx`

**Files:**
- Modify: `src/components/PositionCard.tsx`

**Step 1: Update imports** (line 10)

Replace:
```typescript
import { usePortfolioSettings } from '../context/PortfolioSettingsContext';
```
With:
```typescript
import { useAppSettings } from '../context/AppSettingsContext';
```

**Step 2: Update hook usage** (lines 49–51)

Replace:
```typescript
const settings = usePortfolioSettings();
const portfolioTotal = portfolioTotalProp ?? settings.portfolioTotal;
const stopOutFraction = settings.stopOutFraction;
```
With:
```typescript
const { settings: appSettings, stopOutFraction } = useAppSettings();
const portfolioTotal = portfolioTotalProp ?? appSettings.portfolio.accountSize;
```

**Step 3: Commit**

```bash
git add src/components/PositionCard.tsx
git commit -m "feat: migrate PositionCard.tsx to useAppSettings"
```

---

## Task 8: Migrate `src/components/PortfolioSettingsForm.tsx`

This component will be replaced by the new `AppSettings` page in Task 10, but it's also used inline in `Portfolio.tsx`. Update it to use `useAppSettings` so it continues to work until it's replaced.

**Files:**
- Modify: `src/components/PortfolioSettingsForm.tsx`

**Step 1: Update imports** (line 2)

Replace:
```typescript
import { usePortfolioSettings, MIN_RISK_PCT, MAX_RISK_PCT, MIN_STOP_OUT_PCT, MAX_STOP_OUT_PCT } from '../context/PortfolioSettingsContext';
```
With:
```typescript
import { useAppSettings } from '../context/AppSettingsContext';
import { PORTFOLIO_BOUNDS } from '../lib/types/settings';
const { MIN_RISK_PCT, MAX_RISK_PCT, MIN_STOP_OUT_PCT, MAX_STOP_OUT_PCT } = PORTFOLIO_BOUNDS;
```

**Step 2: Update hook usage** (line 12)

Replace:
```typescript
const { portfolioTotal, riskPct, stopOutPct, setPortfolioTotal, setRiskPct, setStopOutPct, maxRiskPerTrade } = usePortfolioSettings();
```
With:
```typescript
const { settings, updateSettings, maxRiskPerTrade } = useAppSettings();
const { accountSize: portfolioTotal, riskPct, stopOutPct } = settings.portfolio;
const setPortfolioTotal = (v: number) => updateSettings({ portfolio: { ...settings.portfolio, accountSize: v } });
const setRiskPct = (v: number) => updateSettings({ portfolio: { ...settings.portfolio, riskPct: v } });
const setStopOutPct = (v: number) => updateSettings({ portfolio: { ...settings.portfolio, stopOutPct: v } });
```

**Step 3: Commit**

```bash
git add src/components/PortfolioSettingsForm.tsx
git commit -m "feat: migrate PortfolioSettingsForm.tsx to useAppSettings"
```

---

## Task 9: Delete old `PortfolioSettingsContext.tsx`

**Files:**
- Delete: `src/context/PortfolioSettingsContext.tsx`

**Step 1: Verify no remaining imports**

Search for any remaining references:
```bash
grep -r "PortfolioSettingsContext\|usePortfolioSettings\|PortfolioSettingsProvider" src/
```

Expected output: no matches.

**Step 2: Delete the file**

```bash
rm src/context/PortfolioSettingsContext.tsx
```

**Step 3: Run the dev server and verify no TypeScript errors**

```bash
npm run build
```

Expected: build succeeds with no type errors.

**Step 4: Commit**

```bash
git add -u src/context/PortfolioSettingsContext.tsx
git commit -m "feat: remove PortfolioSettingsContext (replaced by AppSettingsContext)"
```

---

## Task 10: Create `src/pages/AppSettings.tsx`

**Files:**
- Create: `src/pages/AppSettings.tsx`

**Step 1: Write the page**

```typescript
// src/pages/AppSettings.tsx
import React, { useState } from 'react';
import { useAppSettings } from '../context/AppSettingsContext';
import { AppSettings, DEFAULT_APP_SETTINGS, PORTFOLIO_BOUNDS } from '../lib/types/settings';
import { formatCurrency } from '../lib/utils';

const { MIN_RISK_PCT, MAX_RISK_PCT, MIN_STOP_OUT_PCT, MAX_STOP_OUT_PCT } = PORTFOLIO_BOUNDS;

export const AppSettingsPage: React.FC = () => {
  const { settings, updateSettings } = useAppSettings();
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleSave = async () => {
    setSaveStatus('saving');
    try {
      await updateSettings(draft);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  const setPortfolio = (patch: Partial<typeof draft.portfolio>) =>
    setDraft(d => ({ ...d, portfolio: { ...d.portfolio, ...patch } }));

  const setWeights = (patch: Partial<typeof draft.techScore.weights>) =>
    setDraft(d => ({ ...d, techScore: { ...d.techScore, weights: { ...d.techScore.weights, ...patch } } }));

  const setPeriods = (patch: Partial<typeof draft.techScore.periods>) =>
    setDraft(d => ({ ...d, techScore: { ...d.techScore, periods: { ...d.techScore.periods, ...patch } } }));

  const weightSum = Object.values(draft.techScore.weights).reduce((a, b) => a + b, 0);
  const maxRiskPreview = (draft.portfolio.accountSize * draft.portfolio.riskPct) / 100;

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-8 pb-28 sm:pb-6">
      <h1 className="text-xl font-semibold text-white">App Settings</h1>

      {/* ── Portfolio / Risk ── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Portfolio / Risk</h2>
          <button
            onClick={() => setDraft(d => ({ ...d, portfolio: DEFAULT_APP_SETTINGS.portfolio }))}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Reset defaults
          </button>
        </div>

        {/* Account Size */}
        <div>
          <label className="text-xs text-gray-400 mb-1.5 block uppercase tracking-wider">Account Size ($)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-mono">$</span>
            <input
              type="number" min={0} step={100}
              value={draft.portfolio.accountSize}
              onChange={e => setPortfolio({ accountSize: parseFloat(e.target.value) || 0 })}
              className="w-full bg-[#000] border border-[#333] text-white rounded-lg pl-8 pr-4 py-2.5 font-mono focus:outline-none focus:border-accent-green"
            />
          </div>
        </div>

        {/* Risk % */}
        <div>
          <label className="text-xs text-gray-400 mb-1.5 block uppercase tracking-wider">
            Risk per Trade ({MIN_RISK_PCT}%–{MAX_RISK_PCT}%)
          </label>
          <div className="flex items-center gap-3">
            <input type="range" min={MIN_RISK_PCT} max={MAX_RISK_PCT} step={0.1}
              value={draft.portfolio.riskPct}
              onChange={e => setPortfolio({ riskPct: parseFloat(e.target.value) })}
              className="flex-1 h-2 bg-[#222] rounded-lg appearance-none cursor-pointer accent-accent-green"
            />
            <input type="number" min={MIN_RISK_PCT} max={MAX_RISK_PCT} step={0.1}
              value={draft.portfolio.riskPct}
              onChange={e => setPortfolio({ riskPct: parseFloat(e.target.value) || MIN_RISK_PCT })}
              className="w-16 px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
            />
            <span className="text-gray-500 text-sm w-4">%</span>
          </div>
          <p className="text-xs text-gray-500 mt-1 font-mono">Risk cap: {formatCurrency(maxRiskPreview)}/trade</p>
        </div>

        {/* Stop-Out % */}
        <div>
          <label className="text-xs text-gray-400 mb-1.5 block uppercase tracking-wider">
            Stop-Out Level ({MIN_STOP_OUT_PCT}%–{MAX_STOP_OUT_PCT}% of max loss)
          </label>
          <div className="flex items-center gap-3">
            <input type="range" min={MIN_STOP_OUT_PCT} max={MAX_STOP_OUT_PCT} step={5}
              value={draft.portfolio.stopOutPct}
              onChange={e => setPortfolio({ stopOutPct: parseFloat(e.target.value) })}
              className="flex-1 h-2 bg-[#222] rounded-lg appearance-none cursor-pointer accent-accent-green"
            />
            <input type="number" min={MIN_STOP_OUT_PCT} max={MAX_STOP_OUT_PCT} step={5}
              value={draft.portfolio.stopOutPct}
              onChange={e => setPortfolio({ stopOutPct: parseFloat(e.target.value) || MIN_STOP_OUT_PCT })}
              className="w-16 px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
            />
            <span className="text-gray-500 text-sm w-4">%</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">Exit when loss reaches this % of max loss.</p>
        </div>
      </section>

      {/* ── Tech Score ── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Tech Score Parameters</h2>
          <button
            onClick={() => setDraft(d => ({ ...d, techScore: DEFAULT_APP_SETTINGS.techScore }))}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            Reset defaults
          </button>
        </div>

        {/* Weights */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-400 uppercase tracking-wider">Weights</p>
            <span className={`text-xs font-mono ${Math.abs(weightSum - 100) > 0.01 ? 'text-accent-red' : 'text-accent-green'}`}>
              Sum: {weightSum}% {Math.abs(weightSum - 100) > 0.01 ? '⚠ must equal 100' : '✓'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {([
              ['w_mb', 'Market Bias'],
              ['w_bxs', 'B-X Short'],
              ['w_bxl', 'B-X Long'],
              ['w_ema', 'EMA Stack'],
              ['w_mom', 'Momentum'],
            ] as [keyof typeof draft.techScore.weights, string][]).map(([key, label]) => (
              <div key={key}>
                <label className="text-xs text-gray-500 mb-1 block">{label}</label>
                <div className="flex items-center gap-2">
                  <input type="number" min={0} max={100} step={1}
                    value={draft.techScore.weights[key]}
                    onChange={e => setWeights({ [key]: parseFloat(e.target.value) || 0 })}
                    className="w-full px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
                  />
                  <span className="text-gray-500 text-sm w-4">%</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Periods */}
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">Periods</p>
          <div className="grid grid-cols-2 gap-3">
            {([
              ['sc_mb_len', 'Market Bias Length'],
              ['sc_mb_smoothing', 'MB Smoothing'],
              ['sc_osc_len', 'Oscillator Length'],
              ['sc_bx_s1', 'B-X Short L1'],
              ['sc_bx_s2', 'B-X Short L2'],
              ['sc_bx_s3', 'B-X Short L3'],
              ['sc_bx_l1', 'B-X Long L1'],
              ['sc_bx_l2', 'B-X Long L2'],
            ] as [keyof typeof draft.techScore.periods, string][]).map(([key, label]) => (
              <div key={key}>
                <label className="text-xs text-gray-500 mb-1 block">{label}</label>
                <input type="number" min={1} max={200} step={1}
                  value={draft.techScore.periods[key]}
                  onChange={e => setPeriods({ [key]: parseInt(e.target.value) || 1 })}
                  className="w-full px-2 py-1.5 bg-[#000] border border-[#333] rounded text-white font-mono text-sm focus:outline-none focus:border-accent-green"
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Save Button ── */}
      <div className="sticky bottom-20 sm:bottom-0 sm:static pt-4 bg-bg-primary sm:bg-transparent">
        <button
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          className={`w-full py-3 rounded-lg font-medium text-sm transition-colors
            ${saveStatus === 'saving' ? 'bg-gray-700 text-gray-400 cursor-not-allowed' :
              saveStatus === 'saved' ? 'bg-accent-green/20 text-accent-green border border-accent-green' :
              saveStatus === 'error' ? 'bg-accent-red/20 text-accent-red border border-accent-red' :
              'bg-accent-green text-black hover:bg-accent-green/90'}`}
        >
          {saveStatus === 'saving' ? 'Saving…' :
           saveStatus === 'saved' ? 'Saved ✓' :
           saveStatus === 'error' ? 'Save failed — try again' :
           'Save Settings'}
        </button>
      </div>
    </div>
  );
};
```

**Step 2: Commit**

```bash
git add src/pages/AppSettings.tsx
git commit -m "feat: add AppSettings page with portfolio and tech score settings"
```

---

## Task 11: Add App Settings tab to navigation

**Files:**
- Modify: `src/components/TabNav.tsx`
- Modify: `src/App.tsx`

**Step 1: Add Settings tab to `TabNav.tsx`**

At the top of the file, add `Settings` to the lucide import:
```typescript
import { LayoutDashboard, List, History, BarChart3, Search, Target, BookOpen, Settings } from 'lucide-react';
```

In the `tabs` array, add after the `academy` entry:
```typescript
{ id: 'settings', label: 'Settings', mobileLabel: 'Settings', Icon: Settings },
```

**Step 2: Add settings case in `src/App.tsx`**

Add import at the top:
```typescript
import { AppSettingsPage } from './pages/AppSettings';
```

Find the section in `App.tsx` that renders tab content (the place where `activeTab === 'portfolio'` renders `<PortfolioPage>` etc.) and add:
```tsx
{activeTab === 'settings' && <AppSettingsPage />}
```

**Step 3: Commit**

```bash
git add src/components/TabNav.tsx src/App.tsx
git commit -m "feat: add Settings tab to navigation"
```

---

## Task 12: Create shared API utility `api/_shared/getAppSettings.js`

**Files:**
- Create: `api/_shared/getAppSettings.js`

**Step 1: Write the utility**

```javascript
// api/_shared/getAppSettings.js
// Fetches the global app settings singleton from Supabase.
// Falls back to hardcoded defaults if the row is missing.

const DEFAULT_SETTINGS = {
  portfolio: { accountSize: 5700, riskPct: 1, stopOutPct: 50 },
  techScore: {
    weights: { w_mb: 30, w_bxs: 30, w_bxl: 15, w_ema: 15, w_mom: 10 },
    periods: {
      sc_mb_len: 20, sc_mb_smoothing: 7, sc_osc_len: 7,
      sc_bx_s1: 5, sc_bx_s2: 20, sc_bx_s3: 5,
      sc_bx_l1: 20, sc_bx_l2: 5,
    },
  },
};

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getAppSettings(supabase) {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('settings')
      .eq('id', 1)
      .single();
    if (error || !data?.settings) return DEFAULT_SETTINGS;
    return {
      ...DEFAULT_SETTINGS,
      ...data.settings,
      portfolio: { ...DEFAULT_SETTINGS.portfolio, ...data.settings.portfolio },
      techScore: {
        weights: { ...DEFAULT_SETTINGS.techScore.weights, ...data.settings.techScore?.weights },
        periods: { ...DEFAULT_SETTINGS.techScore.periods, ...data.settings.techScore?.periods },
      },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
```

**Step 2: Commit**

```bash
git add api/_shared/getAppSettings.js
git commit -m "feat: add getAppSettings shared API utility"
```

---

## Task 13: Update `api/batch-refresh-tech.js` to use settings

**Files:**
- Modify: `api/batch-refresh-tech.js`

**Step 1: Add import at the top** (after existing imports, line 5)

```javascript
import { getAppSettings } from './_shared/getAppSettings.js';
```

**Step 2: Fetch settings after the supabase client is created** (after line 39 `const supabase = createClient(url, key);`)

```javascript
const appSettings = await getAppSettings(supabase);
const techScoreOptions = {
  ...appSettings.techScore.weights,
  ...appSettings.techScore.periods,
};
```

**Step 3: Pass options to `calculateTechScore`** (line 122)

Replace:
```javascript
const scoreResult = calculateTechScore(candles);
```
With:
```javascript
const scoreResult = calculateTechScore(candles, techScoreOptions);
```

**Step 4: Commit**

```bash
git add api/batch-refresh-tech.js
git commit -m "feat: batch-refresh-tech reads tech score params from app_settings"
```

---

## Task 14: Update `api/strategy-recommend.js` to use settings

**Files:**
- Modify: `api/strategy-recommend.js`

**Step 1: Add import at the top** (after the existing imports block, around line 14)

```javascript
import { getAppSettings } from './_shared/getAppSettings.js';
```

**Step 2: Fetch settings once in the handler**

Find where the supabase client is created in `strategy-recommend.js` and add after it:
```javascript
const appSettings = await getAppSettings(supabase);
const techScoreOptions = {
  ...appSettings.techScore.weights,
  ...appSettings.techScore.periods,
};
```

**Step 3: Pass options to `calculateTechScore`** (line 909)

Replace:
```javascript
const scoreResult = calculateTechScore(candles);
```
With:
```javascript
const scoreResult = calculateTechScore(candles, techScoreOptions);
```

**Step 4: Commit**

```bash
git add api/strategy-recommend.js
git commit -m "feat: strategy-recommend reads tech score params from app_settings"
```

---

## Task 15: Update `vite.config.ts` dev handler to use settings

The dev-mode API handler inside `vite.config.ts` (around line 1091) also calls `calculateTechScore(candles)` without options. Update it to also read from Supabase.

**Files:**
- Modify: `vite.config.ts`

**Step 1: Find the `calculateTechScore(candles)` call** (line 1091)

The `vite.config.ts` dev handler already imports `polygon-client.js` and `tech-analysis.js` dynamically. After the `techAnalysis` import, add:

```javascript
// Fetch app settings for tech score options
let techScoreOptions = {};
try {
  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (supabaseUrl && supabaseKey) {
    const sb = createClient(supabaseUrl, supabaseKey);
    const { data } = await sb.from('app_settings').select('settings').eq('id', 1).single();
    if (data?.settings?.techScore) {
      techScoreOptions = { ...data.settings.techScore.weights, ...data.settings.techScore.periods };
    }
  }
} catch (_) {}
```

Then replace:
```javascript
const scoreResult = techAnalysis.calculateTechScore(candles);
```
With:
```javascript
const scoreResult = techAnalysis.calculateTechScore(candles, techScoreOptions);
```

**Step 2: Commit**

```bash
git add vite.config.ts
git commit -m "feat: vite dev handler reads tech score params from app_settings"
```

---

## Task 16: Smoke test and final verification

**Step 1: Run TypeScript build**

```bash
npm run build
```

Expected: No type errors, build succeeds.

**Step 2: Start dev server and verify**

```bash
npm run dev
```

- Open http://localhost:5173
- Navigate to **Settings** tab — verify Portfolio/Risk and Tech Score sections render with current values
- Change Account Size to a different number, click **Save Settings** — verify "Saved ✓" appears
- Navigate to Portfolio tab — verify the new account size shows in the portfolio bar
- In Supabase dashboard, run `SELECT settings FROM app_settings WHERE id = 1;` — verify the changed value is persisted

**Step 3: Verify API uses settings**

- In the Settings tab, change `w_mb` weight (e.g. to 35) and save
- Trigger a batch refresh: `POST /api/batch-refresh-tech`
- Verify the API log/response processes without errors

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: global app settings complete — Supabase-backed, used across frontend and APIs"
```

---

## Summary of Files Changed

| Action  | File |
|---------|------|
| Create  | `docs/migrations/005_app_settings.sql` |
| Create  | `src/lib/types/settings.ts` |
| Create  | `src/context/AppSettingsContext.tsx` |
| Create  | `src/pages/AppSettings.tsx` |
| Create  | `api/_shared/getAppSettings.js` |
| Modify  | `src/main.tsx` |
| Modify  | `src/pages/Portfolio.tsx` |
| Modify  | `src/pages/StrategyRecommender.tsx` |
| Modify  | `src/components/PositionCard.tsx` |
| Modify  | `src/components/PortfolioSettingsForm.tsx` |
| Modify  | `src/components/TabNav.tsx` |
| Modify  | `src/App.tsx` |
| Modify  | `api/batch-refresh-tech.js` |
| Modify  | `api/strategy-recommend.js` |
| Modify  | `vite.config.ts` |
| Delete  | `src/context/PortfolioSettingsContext.tsx` |
