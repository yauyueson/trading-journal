// lib/_shared/strategyConfig.js
// Server-side config loader — used by API routes and crons.
// Reads data/strategy-config.json at request time (always fresh).

import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'data', 'strategy-config.json');

/** Hardcoded fallback if JSON file is missing or corrupt */
const FALLBACK_CONFIG = {
    version: 'fallback',
    source: 'hardcoded defaults',
    profiles: {
        swing: {
            signalPreset: 'vol',
            defaultDelta: 0.35,
            defaultWidth: 20,
            dteMin: 45,
            dteMax: 65,
            dtePeak: 55,
            profitTarget: 0.30,
            ivRankMin: 30,
            timeStopDTE: 5,
            maxPositions: 5,
            maxPerTicker: 3,
            adxGate: null,
            rvolGate: 0.5,
            minScore: 70,
            minDirConfidence: 50,
        },
        shortTerm: {
            signalPreset: 'em',
            defaultDelta: 0.35,
            defaultWidth: 1,
            dteMin: 7,
            dteMax: 21,
            dtePeak: 14,
            profitTarget: 0.35,
            ivRankMin: 50,
            timeStopDTE: 1,
            maxPositions: 5,
            maxPerTicker: 5,
            adxGate: 15,
            rvolGate: 0.5,
            minScore: 70,
            minDirConfidence: 40,
        },
    },
};

/**
 * Load strategy config from JSON file. Returns parsed config object.
 * Falls back to hardcoded defaults if file missing or corrupt.
 */
export function loadStrategyConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(raw);
        if (!config || !config.profiles) {
            console.warn('[strategyConfig] Invalid config file — using fallback');
            return FALLBACK_CONFIG;
        }
        return config;
    } catch (err) {
        console.warn('[strategyConfig] Could not read config file — using fallback:', err.message);
        return FALLBACK_CONFIG;
    }
}

/**
 * Get a specific profile from the config.
 * @param {string} profileKey - 'swing' or 'shortTerm'
 */
export function getProfile(profileKey = 'swing') {
    const config = loadStrategyConfig();
    return config.profiles[profileKey] || config.profiles.swing;
}

/**
 * Load strategy config from Supabase app_settings table.
 * Falls back to JSON file if Supabase unavailable.
 * Uses raw fetch (same pattern as strategy-recommend.js).
 */
export async function loadStrategyConfigFromDB() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
        console.warn('[strategyConfig] No Supabase credentials — using file config');
        return loadStrategyConfig();
    }
    try {
        const res = await fetch(
            `${url}/rest/v1/app_settings?id=eq.1&select=settings`,
            {
                headers: {
                    apikey: key,
                    Authorization: `Bearer ${key}`,
                },
            }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        const settings = rows?.[0]?.settings;
        if (settings?.creditSpread) {
            return {
                version: 'live',
                source: 'supabase',
                profiles: settings.creditSpread,
            };
        }
    } catch (err) {
        console.warn('[strategyConfig] Supabase fetch failed — using file config:', err.message);
    }
    return loadStrategyConfig();
}
