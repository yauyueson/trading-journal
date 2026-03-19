/**
 * tech-analysis-parity.test.ts
 * Verifies that lib/_shared/tech-analysis.cjs (CJS mirror) produces
 * identical output to src/lib/tech-analysis.ts (TypeScript source).
 */

import { describe, it, expect } from 'vitest';
import { calculateTechScore as calculateTechScoreTS, calcDirConfidence as calcDirConfidenceTS } from '../src/lib/tech-analysis';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calculateTechScore: calculateTechScoreCJS, calcDirConfidence: calcDirConfidenceCJS } = require('../lib/_shared/tech-analysis.cjs');

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

    // ── dirConfidence parity ──────────────────────────────────────────────────

    it('uptrend: dirConfidence matches between TS and CJS', () => {
        const ts = calculateTechScoreTS(uptrend);
        const cjs = calculateTechScoreCJS(uptrend);
        expect(cjs.dirConfidence).toBe(ts.dirConfidence);
    });

    it('downtrend: dirConfidence matches between TS and CJS', () => {
        const ts = calculateTechScoreTS(downtrend);
        const cjs = calculateTechScoreCJS(downtrend);
        expect(cjs.dirConfidence).toBe(ts.dirConfidence);
    });

    it('flat market: dirConfidence matches between TS and CJS', () => {
        const ts = calculateTechScoreTS(flat);
        const cjs = calculateTechScoreCJS(flat);
        expect(cjs.dirConfidence).toBe(ts.dirConfidence);
    });

    it('insufficient data: dirConfidence is 0', () => {
        const ts = calculateTechScoreTS(shortData);
        const cjs = calculateTechScoreCJS(shortData);
        expect(ts.dirConfidence).toBe(0);
        expect(cjs.dirConfidence).toBe(0);
    });
});

// ── calcDirConfidence unit tests ──────────────────────────────────────────────

describe('calcDirConfidence', () => {
    it('NEUTRAL direction returns 0', () => {
        expect(calcDirConfidenceTS(0, 1.5, 2.0, true, false, 1.0, 2.0, 30)).toBe(0);
        expect(calcDirConfidenceCJS(0, 1.5, 2.0, true, false, 1.0, 2.0, 30)).toBe(0);
    });

    it('full bullish stack with strong momentum and high ADX → high confidence', () => {
        // CALL: b_stack=true, d8>0, d21>1, ch3>0.5, ch10>0, adx>30
        const ts = calcDirConfidenceTS(1, 2.0, 3.0, true, false, 1.5, 2.0, 35);
        const cjs = calcDirConfidenceCJS(1, 2.0, 3.0, true, false, 1.5, 2.0, 35);
        expect(ts).toBe(cjs);
        expect(ts).toBeGreaterThanOrEqual(70);
        // 95*0.55 + 90*0.30 + 90*0.15 = 52.25+27+13.5 = 92.75 → 93
        expect(ts).toBe(93);
    });

    it('dead cat bounce (below EMAs, CALL direction) → low confidence', () => {
        // CALL but d8<0, d21<0, no b_stack, small bounce ch3>0
        const ts = calcDirConfidenceTS(1, -1.5, -3.0, false, false, 0.3, -2.0, 22);
        const cjs = calcDirConfidenceCJS(1, -1.5, -3.0, false, false, 0.3, -2.0, 22);
        expect(ts).toBe(cjs);
        expect(ts).toBeLessThan(50);
        // ema=15, mom=55 (ch3>0 only), adx=55 → 15*0.55+55*0.30+55*0.15 = 8.25+16.5+8.25 = 33
        expect(ts).toBe(33);
    });

    it('full bearish stack with opposing momentum → moderate', () => {
        // PUT: br_stack=true, d8<0, d21<-1, but ch3>0 (bounce), adx=18
        const ts = calcDirConfidenceTS(-1, -2.0, -3.0, false, true, 0.5, 1.0, 18);
        const cjs = calcDirConfidenceCJS(-1, -2.0, -3.0, false, true, 0.5, 1.0, 18);
        expect(ts).toBe(cjs);
        // ema=95 (br_stack, |d21|>1), mom=35 (ch3Dir=-0.5*-1=0.5>0.5? no, =0.5 → not >0.5; ch3Dir>0 && ch10Dir<0 → ch3>0 only → 55)
        // Wait: dir=-1, ch3=0.5, ch10=1.0. ch3Dir = 0.5 * -1 = -0.5. ch10Dir = 1.0 * -1 = -1.0
        // ch3Dir = -0.5 → not > -0.5 (it's equal) → momScore = 35? No: > -0.5 is false when exactly -0.5
        // ch3Dir = -0.5, check: ch3Dir > -0.5 is false → momScore = 15
        // adx=18: > 15 → adxScore = 35
        // 95*0.55 + 15*0.30 + 35*0.15 = 52.25+4.5+5.25 = 62
        expect(ts).toBe(62);
    });

    it('partial stack CALL with moderate momentum', () => {
        // d8>0, d21>0 but not b_stack → emaScore=70
        const ts = calcDirConfidenceTS(1, 0.5, 0.3, false, false, 0.2, 0.5, 22);
        expect(ts).toBeGreaterThanOrEqual(40);
        expect(ts).toBeLessThanOrEqual(70);
    });

    it('CJS and TS produce identical results for all input combos', () => {
        const cases = [
            [1, 2.0, 3.0, true, false, 1.5, 2.0, 35],
            [-1, -2.0, -3.0, false, true, -1.5, -2.0, 28],
            [1, -0.5, -1.0, false, false, 0.3, -0.5, 12],
            [-1, 1.0, 2.0, true, false, -0.8, 1.0, 22],
            [1, 0.5, 0.5, false, false, 0.1, 0.1, 20],
        ] as const;

        for (const args of cases) {
            const ts = calcDirConfidenceTS(...args);
            const cjs = calcDirConfidenceCJS(...args);
            expect(cjs).toBe(ts);
            expect(ts).toBeGreaterThanOrEqual(0);
            expect(ts).toBeLessThanOrEqual(100);
        }
    });
});
