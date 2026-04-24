// src/lib/strategyConfig.ts
// Settings helpers exposed for the Settings page reset buttons.
//
// History: this module previously exported useStrategyConfig + getConfigProfile
// to bridge Supabase-backed AppSettings with a build-time fallback. Those
// exports were consumed only by the old DTE5 Signals page; the F1 revamp
// (2026-04-23) replaced that page and left them orphaned, so they were
// deleted. AppSettingsContext is now the single source of truth for runtime
// settings — reach for it directly.

import { DEFAULT_APP_SETTINGS } from './types/settings';

/** Default credit-spread config block (used by the Settings "reset" buttons). */
export function getDefaultCreditSpreadConfig() {
  return DEFAULT_APP_SETTINGS.creditSpread!;
}
