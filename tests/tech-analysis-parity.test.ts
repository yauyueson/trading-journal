/**
 * tech-analysis-parity.test.ts
 * Verifies that lib/_shared/tech-analysis.cjs (CJS mirror) produces
 * identical output to src/lib/tech-analysis.ts (TypeScript source).
 */

import { describe, it, expect } from 'vitest';
import { calculateTechScore as calculateTechScoreTS } from '../src/lib/tech-analysis';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calculateTechScore: calculateTechScoreCJS } = require('../lib/_shared/tech-analysis.cjs');

// ── Test data generators ────────────────────────────────────────────────────────

/** Generate synthetic candles with a trend + noise */
function generateCandles(
    count: number,
    startPrice: number,
    dailyReturn: number, // e.g., 0.002 for +0.2%/day
    volatility: number = 0.01, // daily noise
    seed: number = 42,
): { open: number; high: number; low: number; close: number; volume: number }[] {
    // Deterministic pseudo-random
    let rng = seed;
    const rand = () => {
        rng = (rng * 1103515245 + 12345) & 0x7fffffff;
        return (rng / 0x7fffffff) * 2 - 1; // [-1, 1]
    };

    const candles = [];
    let price = startPrice;

    for (let i = 0; i < count; i++) {
        const noise = rand() * volatility;
        const open = price;
        const change = dailyReturn + noise;
        const close = open * (1 + change);
        const high = Math.max(open, close) * (1 + Math.abs(rand() * volatility * 0.5));
        const low = Math.min(open, close) * (1 - Math.abs(rand() * volatility * 0.5));
        const volume = Math.round(1000000 + rand() * 500000);

        candles.push({ open, high, low, close, volume });
        price = close;
    }

    return candles;
}

// ── Parity tests ────────────────────────────────────────────────────────────────

describe('Tech Analysis CJS ↔ TS Parity', () => {
    const uptrend = generateCandles(300, 100, 0.003, 0.012, 42);
    const downtrend = generateCandles(300, 200, -0.003, 0.012, 99);
    const flat = generateCandles(300, 150, 0.0, 0.005, 7);
    const shortData = generateCandles(30, 100, 0.002, 0.01, 1);

    it('uptrend: scores match exactly', () => {
        const ts = calculateTechScoreTS(uptrend);
        const cjs = calculateTechScoreCJS(uptrend);
        expect(cjs.techScore).toBe(ts.techScore);
        expect(cjs.type).toBe(ts.type);
        expect(cjs.setup).toBe(ts.setup);
        expect(cjs.confidence).toBe(ts.confidence);
    });

    it('uptrend: signal string matches', () => {
        const ts = calculateTechScoreTS(uptrend);
        const cjs = calculateTechScoreCJS(uptrend);
        expect(cjs.signal).toBe(ts.signal);
    });

    it('uptrend: all components match', () => {
        const ts = calculateTechScoreTS(uptrend);
        const cjs = calculateTechScoreCJS(uptrend);
        expect(cjs.components).toEqual(ts.components);
    });

    it('uptrend: debug fields match', () => {
        const ts = calculateTechScoreTS(uptrend);
        const cjs = calculateTechScoreCJS(uptrend);
        expect(cjs.debug.mb_osc).toBe(ts.debug.mb_osc);
        expect(cjs.debug.bxs).toBe(ts.debug.bxs);
        expect(cjs.debug.bxl).toBe(ts.debug.bxl);
        expect(cjs.debug.d8).toBe(ts.debug.d8);
        expect(cjs.debug.adx).toBe(ts.debug.adx);
        expect(cjs.debug.rvol).toBe(ts.debug.rvol);
        expect(cjs.debug.regime).toBe(ts.debug.regime);
        expect(cjs.debug.reversal).toBe(ts.debug.reversal);
    });

    it('downtrend: scores and direction match', () => {
        const ts = calculateTechScoreTS(downtrend);
        const cjs = calculateTechScoreCJS(downtrend);
        expect(cjs.techScore).toBe(ts.techScore);
        expect(cjs.type).toBe(ts.type);
        expect(cjs.setup).toBe(ts.setup);
        expect(cjs.confidence).toBe(ts.confidence);
        expect(cjs.components).toEqual(ts.components);
    });

    it('downtrend: debug fields match', () => {
        const ts = calculateTechScoreTS(downtrend);
        const cjs = calculateTechScoreCJS(downtrend);
        expect(cjs.debug).toEqual(ts.debug);
    });

    it('flat market: neutral/low score matches', () => {
        const ts = calculateTechScoreTS(flat);
        const cjs = calculateTechScoreCJS(flat);
        expect(cjs.techScore).toBe(ts.techScore);
        expect(cjs.type).toBe(ts.type);
        expect(cjs.components).toEqual(ts.components);
    });

    it('insufficient data: returns default neutral', () => {
        const ts = calculateTechScoreTS(shortData);
        const cjs = calculateTechScoreCJS(shortData);
        expect(cjs.techScore).toBe(50);
        expect(cjs.type).toBe('NEUTRAL');
        expect(cjs.setup).toBe('Insufficient Data');
        expect(cjs.confidence).toBe(0);
        expect(cjs).toEqual(ts);
    });

    it('custom options: both use same overrides', () => {
        const opts = { w_mb: 30, w_bxs: 25, w_bxl: 10, w_ema: 10, w_mom: 5, w_adx: 10, w_vol: 10 };
        const ts = calculateTechScoreTS(uptrend, opts);
        const cjs = calculateTechScoreCJS(uptrend, opts);
        expect(cjs.techScore).toBe(ts.techScore);
        expect(cjs.type).toBe(ts.type);
        expect(cjs.components).toEqual(ts.components);
    });

    it('returns valid score range [0, 100]', () => {
        for (const candles of [uptrend, downtrend, flat]) {
            const cjs = calculateTechScoreCJS(candles);
            expect(cjs.techScore).toBeGreaterThanOrEqual(0);
            expect(cjs.techScore).toBeLessThanOrEqual(100);
            for (const [, v] of Object.entries(cjs.components)) {
                expect(v as number).toBeGreaterThanOrEqual(0);
                expect(v as number).toBeLessThanOrEqual(100);
            }
        }
    });
});
